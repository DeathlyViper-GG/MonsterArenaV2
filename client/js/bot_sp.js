// ===============================
// SINGLEPLAYER BOT MODULE (upgraded AI)
// ===============================
// This file runs as a plain <script> (no module scope), separate from the
// big pve16.js IIFE. A lot of the game's real logic (world geometry, hazard
// physics, glyph helpers, dash math, chest opening, RNG helpers...) is
// trapped inside that IIFE and is NOT reachable as a bare global. pve16.js
// calls setBotEnv({...}) once (see the BOTS_ENABLED block in startGame/boot)
// to hand us references to everything we need. Do not call those trapped
// functions as bare identifiers — always go through ENV.

let SP_BOTS = [];

let ENV = {
  world: null, ents: null, weapons: null, player: null, cam: null, audio: null,
  losBlocked: null, moveWithCollide: null,
  applyQuicksand: null, applyIceSlide: null, resolveVoid: null,
  openChest: null, applyBurn: null, applyDrench: null, stun: null,
  addEffect: null, spawnDashTrail: null, sweptDashDistance: null,
  dropXpOrb: null, dropPickup: null,
  dist2: null, clamp: null, rand: null, rint: null, pointInRect: null
};

function setBotEnv(env){
  Object.assign(ENV, env || {});
}
// Back-compat shims for older call sites.
function setBotLOS(fn){ ENV.losBlocked = fn; }
function setBotMove(fn){ ENV.moveWithCollide = fn; }

const GLYPH_PATHS = ['fire', 'lightning', 'spirit', 'water', 'earth'];

// ===== local helpers (safe fallbacks if ENV isn't wired yet) =====
function angleTo(ax, ay, bx, by){ return Math.atan2(by - ay, bx - ax); }

function lerpAngle(a, b, t){
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function aimPredict(from, target, bulletSpeed = 900){
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dist = Math.hypot(dx, dy);
  const t = dist / bulletSpeed;
  const vx = target.vx || 0;
  const vy = target.vy || 0;
  return Math.atan2((target.y + vy * t) - from.y, (target.x + vx * t) - from.x);
}

function d2Fallback(ax, ay, bx, by){ const dx = ax - bx, dy = ay - by; return dx*dx + dy*dy; }
function bDist2(ax, ay, bx, by){ return (ENV.dist2 || d2Fallback)(ax, ay, bx, by); }
function bClamp(v, a, c){ return (ENV.clamp || ((v,a,c)=>Math.max(a,Math.min(c,v))))(v, a, c); }

function glyphColor(path){
  const style = (typeof ELEM_STYLE !== 'undefined') ? ELEM_STYLE[path] : null;
  return style ? style.main : '#ffadad';
}

// ===== building / chest helpers (mirrors pve16.js's own, which we can't reach) =====
function botBuildingAt(world, x, y){
  for (const bd of (world.buildings || [])){
    if (!bd.inner) continue;
    if (x >= bd.inner.x && x <= bd.inner.x + bd.inner.w &&
        y >= bd.inner.y && y <= bd.inner.y + bd.inner.h) return bd;
  }
  return null;
}
function botDoorCenters(bd){
  const list = [];
  for (const d of (bd.doors || [])) list.push({ x: d.x + d.w/2, y: d.y + d.h/2, side: d.side, w: d.w, h: d.h });
  return list;
}
function botNearestDoor(bd, x, y){
  let best = null, bestD = Infinity;
  for (const p of botDoorCenters(bd)){
    const dx = p.x - x, dy = p.y - y, d = dx*dx + dy*dy;
    if (d < bestD){ bestD = d; best = p; }
  }
  return best;
}
function findLootableChest(world, b){
  let best = null, bestD = Infinity;
  for (const ch of (world.chests || [])){
    if (!ch || ch.opened) continue;
    const bd = world.buildings[ch.buildingIndex];
    if (!bd) continue;
    const cx = bd.x + bd.w/2, cy = bd.y + bd.h/2;
    const d = (cx - b.x)*(cx - b.x) + (cy - b.y)*(cy - b.y);
    if (d < bestD){ bestD = d; best = { chest: ch, building: bd }; }
  }
  return best;
}

// ===== obstacle-aware steering =====
// Tries the desired direction first; if it's blocked a few steps ahead,
// fans out to either side (alternating which side first) until it finds a
// clear heading, so bots route around walls/buildings instead of just
// grinding into them.
function steerDir(b, world, dirX, dirY){
  if (!world || typeof world.isBlocked !== 'function') return { x: dirX, y: dirY };
  const probe = 46;
  if (!world.isBlocked(b.x + dirX*probe, b.y + dirY*probe, b.r)) return { x: dirX, y: dirY };

  const baseAng = Math.atan2(dirY, dirX);
  const offsets = [0.35, 0.7, 1.1, 1.6, 2.2]; // radians
  for (const off of offsets){
    for (const sign of [b.avoidSign, -b.avoidSign]){
      const a = baseAng + off * sign;
      const nx = Math.cos(a), ny = Math.sin(a);
      if (!world.isBlocked(b.x + nx*probe, b.y + ny*probe, b.r)) return { x: nx, y: ny };
    }
  }
  // boxed in on every heading we tried — flip our preferred side for next
  // time and just back off so we don't sit grinding into geometry.
  b.avoidSign *= -1;
  return { x: -dirX, y: -dirY };
}

// ===== doorway funnel steering =====
// Heading straight at a door's center works fine from a distance, but up
// close a shallow approach angle lets the bot's circle clip the door FRAME
// (the wall either side of the gap) even though the doorway itself is
// open. steerDir's generic obstacle-avoidance then reads that clip as
// "blocked ahead" and fans the bot out sideways to dodge it, which swings
// it further off-axis and trips the same probe again next frame — that
// back-and-forth is the in-place jitter. This lines the bot up with the
// opening along the wall first (a pure sideways slide, no fan-out needed),
// then only pushes straight through once it's actually lined up.
function steerToDoor(b, world, door, speedMul, dt, doMove){
  if (!door) return false;
  const cx = door.x, cy = door.y; // botNearestDoor/botDoorCenters give the center point
  const horizontal = (door.side === 'top' || door.side === 'bottom'); // door gap runs along x
  const tangent = horizontal ? (b.x - cx) : (b.y - cy);
  const span = (horizontal ? (door.w || 60) : (door.h || 60)) / 2;
  const clearance = Math.max(4, span - b.r - 8);

  let dirX, dirY;
  if (Math.abs(tangent) > clearance){
    // Not lined up yet — slide along the wall toward the opening, with a
    // little forward pull blended in so it arcs toward the door instead of
    // pacing the wall forever.
    const alongX = horizontal ? (tangent > 0 ? -1 : 1) : 0;
    const alongY = horizontal ? 0 : (tangent > 0 ? -1 : 1);
    const dx = cx - b.x, dy = cy - b.y;
    const d = Math.hypot(dx, dy) || 1;
    dirX = alongX * 0.75 + (dx / d) * 0.25;
    dirY = alongY * 0.75 + (dy / d) * 0.25;
    const len = Math.hypot(dirX, dirY) || 1;
    dirX /= len; dirY /= len;
  } else {
    const dx = cx - b.x, dy = cy - b.y;
    const d = Math.hypot(dx, dy) || 1;
    dirX = dx / d; dirY = dy / d;
  }

  const steered = steerDir(b, world, dirX, dirY);
  doMove(b, steered.x * b.speed * speedMul * dt, steered.y * b.speed * speedMul * dt);
  b.ang = lerpAngle(b.ang || 0, Math.atan2(cy - b.y, cx - b.x), 0.15);
  return true;
}

// ===== dash =====
function botDash(b, weapons, world, ax, ay){
  if (b.dashCD > 0) return false;
  const w = weapons[b.weapon] || weapons[0];
  const dashDist = w.dash || 380;
  const ox = b.x, oy = b.y;

  const safeDist = ENV.sweptDashDistance
    ? ENV.sweptDashDistance(ox, oy, ax, ay, dashDist, b.r)
    : dashDist;

  b.x = ox + ax * safeDist;
  b.y = oy + ay * safeDist;

  if (world){
    b.x = bClamp(b.x, 60, world.w - 60);
    b.y = bClamp(b.y, 60, world.h - 60);
  }

  b.dashCD = 1.4;
  b.dashI = 0.15;

  if (ENV.spawnDashTrail) ENV.spawnDashTrail(ox, oy, b.x, b.y, glyphColor(b.glyphPath));
  if (ENV.audio && ENV.audio.dash) ENV.audio.dash();
  return true;
}

// ===== hazards (sand / ice / lava / void) =====
// Mirrors the player's own hazard handling. Crucially tracks how long a bot
// has been stuck in quicksand so it can dash itself free, same as a player
// mashing the dash key to escape a sand pit.
function applyBotHazards(b, world, dt){
  b.inSand = false;
  if (!world || typeof world.getHazardAt !== 'function') return;

  const hz = world.getHazardAt(b.x, b.y, b.r * 0.9);
  if (!hz) { b.inSandT = 0; return; }

  if (hz.type === 'sand'){
    if (ENV.applyQuicksand) ENV.applyQuicksand(b, hz, dt, { isPlayer: false });
    if (b.inSand){
      b.inSandT = (b.inSandT || 0) + dt;
      // Stuck for too long -> strategic escape dash, straight out along the
      // radial direction away from the pit's centre.
      if (b.inSandT > 0.9 && b.dashCD <= 0){
        const cx = hz.x + hz.w/2, cy = hz.y + hz.h/2;
        const dx = b.x - cx, dy = b.y - cy;
        const d = Math.hypot(dx, dy) || 1;
        botDash(b, ENV.weapons || [], world, dx/d, dy/d);
        b.inSandT = 0;
      }
    }
  } else if (hz.type === 'ice'){
    if (ENV.applyIceSlide) ENV.applyIceSlide(b, hz, dt);
    b.inSandT = 0;
  } else if (hz.type === 'lava'){
    b.inSandT = 0;
    if (hz.phase === 'erupt') b.hp = 0;
    else if (hz.phase === 'after') b.hp -= 30 * dt;
  } else if (hz.type === 'void'){
    b.inSandT = 0;
    if (ENV.resolveVoid){
      const res = ENV.resolveVoid(b, hz, dt, false);
      if (res && res.done && res.killed) b.hp = 0;
    }
  } else {
    b.inSandT = 0;
  }
}

// ===== weapons =====
function botSetWeapon(b, weapons, idx){
  if (!weapons[idx]) return;
  b.weapon = idx;
  const w = weapons[idx];
  if (b.ammo > w.ammo) b.ammo = w.ammo; // mirrors player setWeapon() clamp behaviour
}

function chooseBotWeapon(b, weapons, distToTarget){
  let pistolI = -1, rifleI = -1, shotI = -1;
  for (let i = 0; i < weapons.length; i++){
    if (weapons[i].kind === 'pistol')  pistolI = i;
    if (weapons[i].kind === 'rifle')   rifleI  = i;
    if (weapons[i].kind === 'shotgun') shotI   = i;
  }

  let want = (pistolI >= 0) ? pistolI : 0;
  if (distToTarget < 190 && shotI >= 0) want = shotI;
  else if (distToTarget < 540 && rifleI >= 0) want = rifleI;
  else if (pistolI >= 0) want = pistolI;

  if (want !== b.weapon && !b.reloading) botSetWeapon(b, weapons, want);
}

function botTryReload(b, w){
  if (b.reloading || b.ammo >= w.ammo || b.reserve <= 0) return;
  b.reloading = true;
  b.reloadT = w.reload;
}

// Pushes one of the game's existing "elemBurst" VFX (fire explosion, water
// splash, lightning bolts, earth burst, spirit glow — see pve16.js's effect
// renderer) at a target, keyed by element. This is how a bot's glyph proc
// actually becomes visible on whoever it's affecting, instead of only ever
// showing on the bot's own ambient ring.
function botGlyphBurstFx(x, y, el, r = 55, life = 0.45){
  if (!ENV.ents || !ENV.ents.effects || !el) return;
  ENV.ents.effects.push({ type: 'elemBurst', kind: el, x, y, r, life, t: 0 });
}

// ===== glyph effects (independent bot loadout — never touches the player's) =====
// Bot glyph bookkeeping lives entirely on the attacking bot object (never on
// the victim) so we never need to add new fields to the sealed `player`
// object. Only existing, already-declared player fields (hp, slowT) are
// ever mutated.
function applyBotGlyphOnEnemyHit(b, e){
  const el = b.glyphPath;
  if (!el || !e) return;
  if (el === 'fire' && ENV.applyBurn){
    ENV.applyBurn(e, 1, 2.6);
    botGlyphBurstFx(e.x, e.y, 'fire');
  } else if (el === 'water' && ENV.applyDrench){
    ENV.applyDrench(e, 1, 3.2);
    botGlyphBurstFx(e.x, e.y, 'water');
  } else if (el === 'lightning' && ENV.stun && Math.random() < 0.35){
    ENV.stun(e, 0.3);
    botGlyphBurstFx(e.x, e.y, 'lightning', 60);
  } else if (el === 'spirit'){
    b.hp = Math.min(b.hpMax || 100, b.hp + 1.5);
    botGlyphBurstFx(b.x, b.y, 'spirit', 40, 0.55);
  }
}

// victim is the player object or another bot — both just need .hp / .slowT
function applyBotGlyphOnHostileHit(b, victim, dmg){
  const el = b.glyphPath;
  if (!el || !victim) return;

  if (el === 'water'){
    victim.slowT = Math.max(victim.slowT || 0, 1.4);
    botGlyphBurstFx(victim.x, victim.y, 'water');
  } else if (el === 'lightning' && victim !== ENV.player && Math.random() < 0.3){
    // only non-player victims get a hard stun — the sealed player object
    // has no stun field and we don't add one here.
    victim._stunT = Math.max(victim._stunT || 0, 0.3);
    botGlyphBurstFx(victim.x, victim.y, 'lightning', 60);
  } else if (el === 'fire'){
    b._burnTarget = victim;
    b._burnUntil = (performance.now() / 1000) + 3.0;
    b._burnDmgPerSec = 5;
    b._burnFxAt = 0; // let the DoT tick (below) show periodic flame bursts
    botGlyphBurstFx(victim.x, victim.y, 'fire');
  } else if (el === 'spirit'){
    b.hp = Math.min(b.hpMax || 100, b.hp + dmg * 0.2);
    botGlyphBurstFx(b.x, b.y, 'spirit', 40, 0.55);
  }
}

// Earth-path bots take reduced damage from everything, mirroring the
// player's Stone Skin passive but kept local to the bot.
function botEarthDamageMul(b){
  return (b.glyphPath === 'earth') ? 0.85 : 1;
}

// ===== firing =====
function botFire(b, weapons, target, targetKind){
  const w = weapons[b.weapon];
  if (!w) return;

  const t = performance.now() / 1000;
  const interval = 1 / (w.rof * (b.reloading ? 0.6 : 1));
  if (t - b.lastShot < interval) return;
  if (b.reloading) return;

  if (b.ammo <= 0){ botTryReload(b, w); return; }

  b.lastShot = t;
  b.ammo--;

  const base = b.ang;
  const ebullets = ENV.ents ? ENV.ents.ebullets : null;
  if (!ebullets) return;

  for (let i = 0; i < w.shots; i++){
    const a = base + (Math.random() * 2 - 1) * w.spread;
    ebullets.push({
      x: b.x + Math.cos(a) * b.r,
      y: b.y + Math.sin(a) * b.r,
      vx: Math.cos(a) * w.speed,
      vy: Math.sin(a) * w.speed,
      r: 4,
      dmg: w.dmg,
      life: 1.2,
      fromBot: b.id,
      team: b.team,
      targetKind,
      glyph: b.glyphPath,
      glyphColor: glyphColor(b.glyphPath),
      ownerRef: b
    });
  }

  if (ENV.addEffect) ENV.addEffect(
    b.x + Math.cos(base) * b.r,
    b.y + Math.sin(base) * b.r,
    'muzzle', 0.1, '#fff'
  );
  if (ENV.audio){
    if (w.kind === 'shotgun' && ENV.audio.shotgun) ENV.audio.shotgun();
    else if (ENV.audio.shoot) ENV.audio.shoot();
  }
}

// ===== INIT =====
function initSPBots(player, COLORS, DESIGNS, gunSheets, spawnPoints){
  SP_BOTS = [];

  // Co-op (no PvP): every bot is on the player's side, no friendly fire.
  // Practice deathmatch (PVP_MODE): bots split into two rival squads so
  // "team vs team vs player" fights actually happen.
  const teamCount = window.PVP_MODE ? 2 : 1;

  // Bot count follows however many spawn points pve16.js handed us (see
  // pickSpreadSpawnPoints in restart()) — 15 for practice PvP, 3 for co-op —
  // falling back to sensible defaults if we were ever called without one.
  const BOT_COUNT = (spawnPoints && spawnPoints.length)
    ? spawnPoints.length
    : (window.PVP_MODE ? 15 : 3);

  for (let i = 0; i < BOT_COUNT; i++){
    const glyphPath = GLYPH_PATHS[Math.floor(Math.random() * GLYPH_PATHS.length)];

    // Use a pre-picked, spread-out map position when the caller supplies one
    // (see pickSpreadSpawnPoints in pve16.js); otherwise fall back to the
    // old "somewhere near the player" scatter.
    const sp = spawnPoints && spawnPoints[i];
    const spawnX = sp ? sp.x : player.x + (Math.random() - 0.5) * 800;
    const spawnY = sp ? sp.y : player.y + (Math.random() - 0.5) * 800;

    SP_BOTS.push({
      id: "bot_" + i,
      name: "Bot_" + (100 + i),

      x: spawnX,
      y: spawnY,
      ang: Math.random() * Math.PI * 2,

      hp: 100, hpMax: 100,
      r: 16,
      vx: 0, vy: 0,
      speed: 180,

      design: Math.floor(Math.random() * DESIGNS.length),
      color: Math.floor(Math.random() * COLORS.length),

      guns: {
        pistol: Math.floor(Math.random() * gunSheets.pistols.length),
        rifle: Math.floor(Math.random() * gunSheets.rifles.length),
        shotgun: Math.floor(Math.random() * gunSheets.shotguns.length)
      },

      weapon: 0,
      ammo: 15, reserve: 90, reloading: false, reloadT: 0, lastShot: 0,
      equip: "gun",

      team: teamCount > 1 ? (i % teamCount) : 0,

      target: null, targetKind: null,
      shootCD: 0, dodgeCD: 0, wanderT: 0,

      dashCD: 0, dashI: 0, inSand: false, inSandT: 0,

      essence: 0,

      // Independent glyph loadout — never depends on the player's path,
      // and "levels up" over the course of the match on its own timer.
      glyphPath,
      glyphTier: 0,
      glyphUpT: 14 + Math.random() * 10,
      _burnTarget: null, _burnUntil: 0, _burnDmgPerSec: 0,
      _stunT: 0, slowT: 0,

      // chest looting
      seekingChest: false, chestTarget: null, chestBuilding: null, chestDoor: null,

      // building-exit recovery (see STUCK-IN-BUILDING RECOVERY in update loop)
      _exitBuilding: null, _exitDoor: null,

      state: "idle", stateT: 0, decisionCD: 0,
      side: Math.random() < 0.5 ? -1 : 1,
      avoidSign: Math.random() < 0.5 ? -1 : 1
    });
  }
}

// ===== zone (death circle) awareness =====
// Reads the same shrinking safe-circle the player sees (see initZone/
// updateZone/drawZone in pve16.js). While the zone is calmly "waiting" to
// shrink, the NEXT circle is already picked and shown to the player as a
// dashed preview ring — bots read that same telegraph so they start
// repositioning before the storm reaches them, not only once it already
// hurts.
// Returns null if the bot is comfortably inside the (upcoming) safe circle.
// Otherwise returns { x, y, urgent } — x/y is the point to walk toward,
// urgent is true if the bot is outside the LIVE circle and taking damage
// right now (vs. just outside where the circle is about to shrink to).
function zoneFleeTarget(b, zone){
  if (!zone) return null;
  const nextKnown = (zone.mode === 'wait' && zone.nextPicked);
  const safeCx = nextKnown ? zone.toX : zone.cx;
  const safeCy = nextKnown ? zone.toY : zone.cy;
  const safeR  = nextKnown ? zone.toR : zone.r;

  const margin = 60; // stay a comfortable step inside the line, not hugging it
  const distToSafeCenter = Math.hypot(b.x - safeCx, b.y - safeCy);
  if (distToSafeCenter <= safeR - margin) return null;

  const liveDx = b.x - zone.cx, liveDy = b.y - zone.cy;
  const urgent = (liveDx * liveDx + liveDy * liveDy) > zone.r * zone.r;

  return { x: safeCx, y: safeCy, urgent };
}

// ===== UPDATE =====
function updateSPBots(dt, player, ents, world, weapons, zone){
  if (!window.BOTS_ENABLED) return;

  const dist2 = ENV.dist2 || d2Fallback;
  const moveWithCollide = ENV.moveWithCollide || function(o, dx, dy){ o.x += dx; o.y += dy; };
  const losBlocked = ENV.losBlocked || (() => false);
  const now = performance.now() / 1000;

  for (const b of SP_BOTS){
    if (b.hp <= 0) continue;

    // ---- status timers ----
    if (b._stunT > 0) b._stunT = Math.max(0, b._stunT - dt);
    if (b.slowT  > 0) b.slowT  = Math.max(0, b.slowT  - dt);
    if (b.dashCD > 0) b.dashCD = Math.max(0, b.dashCD - dt);
    if (b.dashI  > 0) b.dashI  = Math.max(0, b.dashI  - dt);

    // fire DoT this bot has applied to something (player or another bot)
    if (b._burnUntil > now && b._burnTarget && b._burnTarget.hp > 0){
      b._burnTarget.hp -= (b._burnDmgPerSec || 4) * dt;
      // small recurring flame flicker so the burn stays visible for its
      // whole duration, not just the instant it was applied
      b._burnFxAt = (b._burnFxAt || 0) - dt;
      if (b._burnFxAt <= 0){
        b._burnFxAt = 0.4;
        botGlyphBurstFx(b._burnTarget.x, b._burnTarget.y, 'fire', 34, 0.3);
      }
    } else if (b._burnUntil <= now){
      b._burnTarget = null;
    }

    // glyph "leveling" — purely a bot-side power/visual ramp, fully
    // independent of whatever path the player picked.
    b.glyphUpT -= dt;
    if (b.glyphUpT <= 0 && b.glyphTier < 3){
      b.glyphTier++;
      b.glyphUpT = 20 + Math.random() * 15;
      if (ENV.addEffect) ENV.addEffect(b.x, b.y, 'pop', 0.4, glyphColor(b.glyphPath));
    }

    const speedMul = (b.slowT > 0 ? 0.7 : 1);

    if (b._stunT > 0){
      applyBotHazards(b, world, dt);
      continue; // stunned this tick
    }

    // ==========================================================
    // STUCK-IN-BUILDING RECOVERY — highest priority short of being
    // stunned. A bot standing inside a building's walls for any reason
    // OTHER than deliberately looting that exact building's chest gets out
    // via the nearest door before it does anything else — chasing,
    // wandering, or fleeing the death zone from inside a building just
    // grinds the bot into an interior wall instead of routing through a
    // doorway, which is what was actually leaving bots standing still
    // eating storm damage instead of getting anywhere.
    // ==========================================================
    const insideBuilding = world ? botBuildingAt(world, b.x, b.y) : null;
    if (insideBuilding && !(b.seekingChest && b.chestBuilding === insideBuilding)){
      // Lock onto one door for this building instead of re-picking the
      // nearest one every frame, which can flip-flop between two similarly
      // close doors and make the bot jitter in place.
      if (b._exitBuilding !== insideBuilding){
        b._exitBuilding = insideBuilding;
        b._exitDoor = botNearestDoor(insideBuilding, b.x, b.y);
      }
      const door = b._exitDoor || botNearestDoor(insideBuilding, b.x, b.y);
      if (door){
        steerToDoor(b, world, door, speedMul, dt, moveWithCollide);
      }
      applyBotHazards(b, world, dt);
      continue;
    } else {
      b._exitBuilding = null;
      b._exitDoor = null;
    }

    // ==========================================================
    // TARGET SELECTION
    // ==========================================================
    let target = null, targetKind = null, bestD2 = Infinity;
    const SIGHT2 = 700 * 700;

    for (const e of (ents.enemies || [])){
      const d2 = dist2(e.x, e.y, b.x, b.y);
      if (d2 > SIGHT2) continue;
      if (losBlocked(b.x, b.y, e.x, e.y)) continue;
      if (d2 < bestD2){ bestD2 = d2; target = e; targetKind = 'enemy'; }
    }

    if (window.PVP_MODE){
      const dP = dist2(player.x, player.y, b.x, b.y);
      if (dP < bestD2 && dP < SIGHT2 && !losBlocked(b.x, b.y, player.x, player.y)){
        bestD2 = dP; target = player; targetKind = 'player';
      }
      for (const other of SP_BOTS){
        if (other === b || other.hp <= 0 || other.team === b.team) continue;
        const dO = dist2(other.x, other.y, b.x, b.y);
        if (dO < bestD2 && dO < SIGHT2 && !losBlocked(b.x, b.y, other.x, other.y)){
          bestD2 = dO; target = other; targetKind = 'bot';
        }
      }
    }

    // ---- team coordination: assist a teammate who's already fighting ----
    // Bots "sometimes" (70%) rally to a teammate's fight instead of always
    // piling on, so the squad doesn't read as one hive mind.
    if (!target){
      for (const ally of SP_BOTS){
        if (ally === b || ally.hp <= 0 || ally.team !== b.team) continue;
        if (!ally.target) continue;
        const dAlly = dist2(ally.x, ally.y, b.x, b.y);
        if (dAlly < 900*900 && Math.random() < 0.7){
          target = ally.target;
          targetKind = ally.targetKind;
          break;
        }
      }
    }

    b.target = target;
    b.targetKind = targetKind;

    // ==========================================================
    // DEATH ZONE — figure out (once per bot per tick) whether this bot
    // needs to be heading back toward the safe circle at all.
    // ==========================================================
    const zoneFlee = zoneFleeTarget(b, zone);

    // ==========================================================
    // DEATH ZONE (urgent) — actively taking storm damage right now. This
    // beats everything else, including a fight in progress: trading shots
    // while the zone ticks you down on top of it is a losing move, so run
    // for the circle first and only take free shots along the way.
    // ==========================================================
    if (zoneFlee && zoneFlee.urgent){
      const dx = zoneFlee.x - b.x, dy = zoneFlee.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      if (b.dashCD <= 0 && Math.random() < 0.35){
        botDash(b, weapons, world, dx/d, dy/d);
      }
      const want = Math.atan2(dy, dx);
      b.ang = lerpAngle(b.ang || 0, want, 0.12);
      const steered = steerDir(b, world, dx/d, dy/d);
      moveWithCollide(b, steered.x * b.speed * speedMul * dt, steered.y * b.speed * speedMul * dt);
      applyBotHazards(b, world, dt);
      if (target && Math.hypot(target.x - b.x, target.y - b.y) < 300){
        botFire(b, weapons, target, targetKind);
      }
      continue;
    }

    // ==========================================================
    // LOW HP — retreat toward the player's general area (safety in numbers)
    // ==========================================================
    if (b.hp < 28 && target){
      const distToTarget = Math.hypot(target.x - b.x, target.y - b.y);
      if (distToTarget < 260 && b.dashCD <= 0){
        const dx = b.x - target.x, dy = b.y - target.y;
        const d = Math.hypot(dx, dy) || 1;
        botDash(b, weapons, world, dx/d, dy/d);
      }
      let awayX = b.x - target.x, awayY = b.y - target.y;
      const awayLen = Math.hypot(awayX, awayY) || 1;
      awayX /= awayLen; awayY /= awayLen;
      // Don't retreat straight out of the safe circle just to put distance
      // between itself and its attacker.
      if (zoneFlee){
        const zx = zoneFlee.x - b.x, zy = zoneFlee.y - b.y;
        const zd = Math.hypot(zx, zy) || 1;
        awayX = awayX * 0.6 + (zx / zd) * 0.4;
        awayY = awayY * 0.6 + (zy / zd) * 0.4;
        const aLen = Math.hypot(awayX, awayY) || 1;
        awayX /= aLen; awayY /= aLen;
      }
      const want = Math.atan2(awayY, awayX);
      b.ang = lerpAngle(b.ang || 0, want, 0.08);
      const steered = steerDir(b, world, Math.cos(b.ang), Math.sin(b.ang));
      moveWithCollide(b, steered.x * b.speed * speedMul * dt, steered.y * b.speed * speedMul * dt);
      applyBotHazards(b, world, dt);
      continue;
    }

    // ==========================================================
    // CHEST LOOTING (no fight to focus on)
    // ==========================================================
    if (!target){
      if (b.seekingChest && b.chestTarget && b.chestTarget.opened){
        b.seekingChest = false; b.chestTarget = null; b.chestBuilding = null; b._chestInside = false;
      }
      if (!b.seekingChest && Math.random() < 0.01 && world){
        const found = findLootableChest(world, b);
        if (found){
          b.seekingChest = true;
          b.chestTarget = found.chest;
          b.chestBuilding = found.building;
          b.chestDoor = botNearestDoor(found.building, b.x, b.y);
          b._chestInside = false; // reset the "made it through the door" latch
        }
      }
    } else if (b.seekingChest){
      b.seekingChest = false; // combat takes priority over looting
    }

    if (b.seekingChest && b.chestTarget && world){
      // Once the bot is close enough to its door, latch "inside" permanently
      // for this chest run instead of re-checking point-in-rect every frame.
      // The door's *center* sits exactly on the wall's midline (see
      // makeDoors/botNearestDoor), which is just outside the inner-rect
      // containment test — so a bot walking straight at the door arrives at
      // a point that reads as "not inside yet" with ~zero distance left to
      // travel. Direction to goal degenerates, steerDir's obstacle probe
      // starts firing off the doorframe, and the bot visibly jitters in and
      // out of the doorway instead of committing to enter. Latching prevents
      // that flicker by never re-testing "inside" once we've clearly crossed
      // the threshold.
      if (!b._chestInside){
        const doorNear = b.chestDoor && Math.hypot(b.chestDoor.x - b.x, b.chestDoor.y - b.y) < (b.r + 24);
        if (doorNear || botBuildingAt(world, b.x, b.y) === b.chestBuilding){
          b._chestInside = true;
        }
      }
      const insideBuilding = b._chestInside;

      if (!insideBuilding && b.chestDoor){
        // Same doorway-funnel approach as building-exit — avoids the same
        // clip-and-jitter when lining up with the door from an angle.
        steerToDoor(b, world, b.chestDoor, speedMul, dt, moveWithCollide);
      } else {
        const goal = b.chestTarget;
        const dx = goal.x - b.x, dy = goal.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const dirX = dx / d, dirY = dy / d;
        const steered = steerDir(b, world, dirX, dirY);
        moveWithCollide(b, steered.x * b.speed * speedMul * dt, steered.y * b.speed * speedMul * dt);
        b.ang = lerpAngle(b.ang || 0, Math.atan2(dy, dx), 0.12);
      }

      const d = Math.hypot(b.chestTarget.x - b.x, b.chestTarget.y - b.y);
      if (insideBuilding && d < (b.r + (b.chestTarget.r || 16) + 8)){
        if (ENV.openChest) ENV.openChest(b.chestTarget);
        b.seekingChest = false;
        b.chestTarget = null;
        b.chestBuilding = null;
        b._chestInside = false;
      }

      applyBotHazards(b, world, dt);
      continue;
    }

    // ==========================================================
    // STATE DECISION
    // ==========================================================
    b.decisionCD -= dt;
    if (b.decisionCD <= 0){
      b.decisionCD = 0.25 + Math.random() * 0.25;

      if (!target){
        b.state = "wander";
      } else {
        chooseBotWeapon(b, weapons, Math.hypot(target.x - b.x, target.y - b.y));
        const w = weapons[b.weapon];
        const ideal = (w.kind === 'shotgun') ? 130 : (w.kind === 'rifle') ? 380 : 260;
        const d = Math.hypot(target.x - b.x, target.y - b.y);

        if (d > ideal * 1.4) b.state = "chase";
        else if (d < ideal * 0.55 && w.kind !== 'shotgun') b.state = "evade";
        else b.state = "attack";
      }
    }

    // ==========================================================
    // MOVEMENT
    // ==========================================================
    if (target){
      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const d = Math.hypot(dx, dy) || 1;

      let moveX = dx / d, moveY = dy / d;

      if (b.state === "evade"){
        moveX *= -0.6; moveY *= -0.6;
        moveX += (-moveY) * b.side * 0.8;
        moveY += ( moveX) * b.side * 0.8;
      } else if (b.state === "attack"){
        // strafe around the target instead of walking straight at it
        const strafeX = -moveY, strafeY = moveX;
        moveX = moveX * 0.25 + strafeX * b.side * 0.6;
        moveY = moveY * 0.25 + strafeY * b.side * 0.6;
      }
      // "chase" keeps the raw direction toward the target

      // Death-zone pull: near (but not yet past) the safe line, drift the
      // fight back toward the circle instead of trading shots right at the
      // edge — not a full panic like the "urgent" case above, just a bias.
      if (zoneFlee){
        const zx = zoneFlee.x - b.x, zy = zoneFlee.y - b.y;
        const zd = Math.hypot(zx, zy) || 1;
        const pull = 0.4;
        moveX = moveX * (1 - pull) + (zx / zd) * pull;
        moveY = moveY * (1 - pull) + (zy / zd) * pull;
        const mLen = Math.hypot(moveX, moveY) || 1;
        moveX /= mLen; moveY /= mLen;
      }

      const len = Math.hypot(moveX, moveY) || 1;
      moveX /= len; moveY /= len;

      const steered = steerDir(b, world, moveX, moveY);

      const steps = 4;
      for (let i = 0; i < steps; i++){
        moveWithCollide(b, (steered.x * b.speed * speedMul * dt) / steps, (steered.y * b.speed * speedMul * dt) / steps);
      }

      // ---- strategic dash: close distance when chasing a kiting target ----
      if (b.state === "chase" && d > 420 && b.dashCD <= 0 && Math.random() < 0.02 &&
          !(world && world.isBlocked && world.isBlocked(b.x + (dx/d)*200, b.y + (dy/d)*200, b.r))){
        botDash(b, weapons, world, dx/d, dy/d);
      }

      applyBotHazards(b, world, dt);

      let aim = aimPredict(b, target, weapons[b.weapon] ? weapons[b.weapon].speed : 900);
      aim += (Math.random() - 0.5) * 0.12;
      b.ang = lerpAngle(b.ang || 0, aim, 0.18);
    } else {
      applyBotHazards(b, world, dt);
    }

    // ==========================================================
    // SHOOTING
    // ==========================================================
    if (target){
      botFire(b, weapons, target, targetKind);
    }

    // ==========================================================
    // DODGE — evasive dash/strafe away from a close incoming bullet.
    // Checks both ents.ebullets (monster/other-bot fire) AND ents.bullets
    // (the actual player's gunfire) — previously bots only ever reacted to
    // ebullets, so a player's own shots walked straight through them.
    // ==========================================================
    b.dodgeCD -= dt;
    if (b.dodgeCD <= 0){
      let threat = null, threatD2 = Infinity;
      const scanForThreat = (list, isOwnList) => {
        if (!list) return;
        for (const proj of list){
          if (!proj) continue;
          if (isOwnList && proj.fromBot === b.id) continue; // ignore our own shots
          const vx = proj.vx || 0, vy = proj.vy || 0;
          const dx = b.x - proj.x, dy = b.y - proj.y;
          const d2raw = dx*dx + dy*dy;
          if (d2raw > 260*260) continue;
          const spd2 = vx*vx + vy*vy;
          if (spd2 < 1) continue;
          // time (seconds) until this bullet's closest approach to us
          const t = -(dx*vx + dy*vy) / spd2;
          if (t < 0 || t > 0.5) continue;
          const cx = proj.x + vx*t, cy = proj.y + vy*t;
          const missDx = b.x - cx, missDy = b.y - cy;
          const dangerR = (b.r || 16) + 50;
          if (missDx*missDx + missDy*missDy > dangerR*dangerR) continue;
          if (d2raw < threatD2){ threatD2 = d2raw; threat = proj; }
        }
      };
      scanForThreat(ents.ebullets, true);
      scanForThreat(ents.bullets, false);

      if (threat){
        b.dodgeCD = 0.7 + Math.random() * 0.3;
        if (b.dashCD <= 0 && Math.random() < 0.5){
          const perp = Math.atan2(threat.vy || 0, threat.vx || 0) + Math.PI/2 * (Math.random() < 0.5 ? 1 : -1);
          botDash(b, weapons, world, Math.cos(perp), Math.sin(perp));
        } else {
          b.ang = lerpAngle(b.ang || 0, (b.ang || 0) + Math.PI/2, 0.2);
        }
      }
    }

    // ==========================================================
    // WANDER
    // ==========================================================
    if (!target && !b.seekingChest){
      b.wanderT -= dt;
      if (b.wanderT <= 0){
        b.wanderT = 2 + Math.random() * 2;
        // With nothing to fight and nothing to loot, a bot near the zone
        // edge wanders generally toward safety instead of a pure random
        // heading, same as a player would just walking back in.
        const want = zoneFlee
          ? Math.atan2(zoneFlee.y - b.y, zoneFlee.x - b.x) + (Math.random() - 0.5) * 0.9
          : Math.random() * Math.PI * 2;
        b.ang = lerpAngle(b.ang || 0, want, 0.08);
      }
      const steered = steerDir(b, world, Math.cos(b.ang), Math.sin(b.ang));
      moveWithCollide(b, steered.x * b.speed * 0.6 * speedMul * dt, steered.y * b.speed * 0.6 * speedMul * dt);
    }

    // ==========================================================
    // RELOAD
    // ==========================================================
    const w = weapons[b.weapon];
    if (w){
      if (b.ammo <= 0 && !b.reloading) botTryReload(b, w);
      if (b.reloading){
        b.reloadT -= dt;
        if (b.reloadT <= 0){
          b.reloading = false;
          const need = Math.min(w.ammo - b.ammo, b.reserve);
          b.ammo += need;
          b.reserve -= need;
        }
      }
      // slow passive reserve trickle so bots don't run permanently dry
      if (b.reserve < 200) b.reserve += 3 * dt;
    }

    // ==========================================================
    // PICKUPS (ammo/health/xp on the ground)
    // ==========================================================
    for (let i = (ents.pickups || []).length - 1; i >= 0; i--){
      const p = ents.pickups[i];
      const dx = p.x - b.x, dy = p.y - b.y;
      const d = Math.hypot(dx, dy);

      if (d < 200 && !target){
        const a = Math.atan2(dy, dx);
        const steered = steerDir(b, world, Math.cos(a), Math.sin(a));
        moveWithCollide(b, steered.x * b.speed * speedMul * dt, steered.y * b.speed * speedMul * dt);
      }

      if (d < 20){
        if (p.type === "xp") b.essence++;
        else if (p.type === "ammo") b.reserve += 20;
        else if (p.type === "health") b.hp = Math.min(b.hpMax, b.hp + 20);
        ents.pickups.splice(i, 1);
      }
    }
  }

  // ==============================================================
  // BOT BULLETS vs PvE ENEMIES — bot-fired shots (ents.ebullets tagged
  // with fromBot) also need to be able to hurt monsters, not just the
  // player/other bots (that half is handled by pve16.js's own collision
  // loop, which we can't reach from here).
  // ==============================================================
  if (ents.ebullets && ents.enemies && ents.enemies.length){
    for (let i = ents.ebullets.length - 1; i >= 0; i--){
      const eb = ents.ebullets[i];
      if (!eb || !eb.fromBot) continue;

      for (let j = 0; j < ents.enemies.length; j++){
        const e = ents.enemies[j];
        const rr = (e.r || 16) + (eb.r || 4);
        if (dist2(eb.x, eb.y, e.x, e.y) < rr*rr){
          e.hp -= eb.dmg;
          if (eb.ownerRef) applyBotGlyphOnEnemyHit(eb.ownerRef, e);
          if (ENV.addEffect) ENV.addEffect(eb.x, eb.y, 'hit', 0.12, '#fff');

          if (e.hp <= 0){
            if (ENV.dropXpOrb) ENV.dropXpOrb(e.x, e.y, 1);
            ents.enemies.splice(j, 1);
          }
          ents.ebullets.splice(i, 1);
          break;
        }
      }
    }
  }

  SP_BOTS = SP_BOTS.filter(b => b.hp > 0);
}

// ===== DRAW =====
function drawSPBots(ctx, cam, COLORS, drawDesign, weapons, gunSheets){
  for (const b of SP_BOTS){
    const px = b.x - cam.x - cam.sx;
    const py = b.y - cam.y - cam.sy;

    // Glyph aura — visual tell for the bot's independent glyph path/tier
    if (b.glyphPath){
      const col = glyphColor(b.glyphPath);
      ctx.save();
      ctx.globalAlpha = 0.25 + b.glyphTier * 0.08;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2 + b.glyphTier;
      ctx.beginPath();
      ctx.arc(px, py, 26 + b.glyphTier * 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(b.ang);

    drawDesign(
      b.design,
      COLORS[b.color].c,
      performance.now() / 1000,
      16
    );

    const w = weapons[b.weapon];
    let img = null;
    if (w){
      if (w.kind === 'pistol')  img = gunSheets.pistols[b.guns.pistol];
      if (w.kind === 'rifle')   img = gunSheets.rifles[b.guns.rifle];
      if (w.kind === 'shotgun') img = gunSheets.shotguns[b.guns.shotgun];
    }
    if (img) ctx.drawImage(img, 14, -6, 36, 24);

    ctx.restore();

    ctx.strokeStyle = "#000";
    ctx.beginPath();
    ctx.arc(px, py, 22, 0, Math.PI*2);
    ctx.stroke();

    ctx.strokeStyle = (b.hp / b.hpMax) > 0.3 ? "#66ff66" : "#ff6666";
    ctx.beginPath();
    ctx.arc(px, py, 22, -Math.PI/2, -Math.PI/2 + (b.hp/b.hpMax)*Math.PI*2);
    ctx.stroke();

    if (b.reloading){
      ctx.fillStyle = "#ffd76a";
      ctx.beginPath();
      ctx.arc(px, py - 30, 3, 0, Math.PI*2);
      ctx.fill();
    }
  }
}
