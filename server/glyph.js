// ===============================
// SERVER-AUTHORITATIVE GLYPH SYSTEM
// ===============================
// Mirrors (a practical subset of) the client-side glyph tree in pve16.js
// so that glyph bonuses actually affect real (server-owned) damage/HP
// in online PvE, instead of only ever running on each client's local
// visual copy of the enemies (which the server snapshot overwrites anyway).
//
// Scope: the numeric/damage/defense effects that plug directly into the
// existing HP systems. Nodes that would need whole new entity/AI systems
// (wisp orbit allies, shade summons, stone pillars, golem, ball lightning,
// dash/blink movement, freeze/shatter, revive) are NOT ported here — they
// remain single-player-only "flavor" for now and are simply no-ops online.

// Every valid node key per element (used to validate /glyph/unlock requests).
export const GLYPH_KEYS = {
  fire: ['hotCoals', 'searingShots', 'ashenFinish', 'detonate', 'napalmTrail', 'volcanicCore', 'cauterise', 'phoenixStep', 'rebirth'],
  lightning: ['arcJump', 'forkedArc', 'stormConductor', 'chargedRounds', 'overload', 'thunderclap', 'staticDash', 'blinkStrike', 'ballLightning'],
  spirit: ['wispOrbit', 'wispSwarm', 'guardianSpirits', 'haunt', 'soulBind', 'dreadBloom', 'revenant', 'possession', 'wraithKing'],
  water: ['chill', 'iceShards', 'permafrost', 'mendingMist', 'tidalRenewal', 'sanctuary', 'rippleShot', 'tidalWave', 'maelstrom'],
  earth: ['thornmail', 'spikedBarrier', 'jaggedEarth', 'bulwark', 'rootedStance', 'unbreakable', 'stonePillar', 'quake', 'golem'],
};

const ELEMENTS = Object.keys(GLYPH_KEYS);

export function makeGlyphState() {
  const glyph = {};
  for (const el of ELEMENTS) glyph[el] = {};
  return glyph;
}

function isPath(p, el) {
  return p.glyphPath === el || !!(p.completedGlyphs && p.completedGlyphs[el]);
}
function hasG(p, el, key) {
  return !!(p.glyph && p.glyph[el] && p.glyph[el][key]);
}

// Per-enemy status (burn/drench/etc). Stored directly on the enemy object
// under `_status` so it lives and dies with the enemy naturally.
function statusOf(e) {
  if (!e._status) {
    e._status = { burnT: 0, burnStacks: 0, staticT: 0, staticPrimed: false, drenchT: 0, drenchStacks: 0 };
  }
  return e._status;
}

// Called every server tick for every live PvE enemy: ticks DoTs / timers
// that don't require a fresh hit (burn damage-over-time, status decay,
// stun/slow expiry). Returns true if this tick's DoT killed the enemy.
export function tickEnemyGlyphStatus(lobby, e, dt) {
  const s = e._status;
  if (!s) return false;

  if (s.burnT > 0) {
    s.burnT -= dt;
    if (s.burnStacks > 0) {
      e.hp -= (2 * s.burnStacks) * dt; // small DoT, scales with stacks (mirrors client Hot Coals)
    }
    if (s.burnT <= 0) { s.burnT = 0; s.burnStacks = 0; }
  }
  if (s.staticT > 0) {
    s.staticT -= dt;
    if (s.staticT <= 0) { s.staticT = 0; s.staticPrimed = false; }
  }
  if (s.drenchT > 0) {
    s.drenchT -= dt;
    if (s.drenchT <= 0) { s.drenchT = 0; s.drenchStacks = 0; }
  }
  if ((e._stunT ?? 0) > 0) e._stunT = Math.max(0, e._stunT - dt);
  if ((e._slowT ?? 0) > 0) e._slowT = Math.max(0, e._slowT - dt);

  return e.hp <= 0;
}

// Movement-speed multiplier from glyph status (used by enemyAI before it
// integrates movement). Kept separate from tickEnemyGlyphStatus so callers
// can apply it without double-processing timers.
export function glyphMoveMul(e) {
  let mul = 1;
  if ((e._stunT ?? 0) > 0) return 0;
  if ((e._slowT ?? 0) > 0) mul *= 0.7;
  return mul;
}

function aoeDamage(lobby, x, y, r, dmg, ownerId) {
  const rr = r * r;
  for (const e of lobby.enemies) {
    if (e.hp <= 0) continue;
    const dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy <= rr) {
      e.hp -= dmg;
      if (ownerId) e._lastHitBy = ownerId;
    }
  }
}

// Applies a landed hit (bullet or melee) from `p` (the player object,
// server-authoritative) against enemy `e`, given the weapon's base damage.
// Mutates e.hp (and possibly nearby enemies / the player) for every glyph
// effect that's implemented, and returns nothing — callers should re-check
// e.hp <= 0 afterwards the same way they already do for plain hits.
export function applyGlyphHit(lobby, p, e, baseDmg, hitKind) {
  if (!p || !e) { if (e) e.hp -= baseDmg; return; }

  const s = statusOf(e);
  let mult = 1;
  e._lastHitBy = p.id;

  // ===== FIRE =====
  if (isPath(p, 'fire') && hasG(p, 'fire', 'hotCoals')) {
    s.burnStacks = Math.min(3, s.burnStacks + 1);
    s.burnT = Math.max(s.burnT, 3.6);

    if (hasG(p, 'fire', 'searingShots') && s.burnStacks > 0) {
      mult *= 1.18;
    }
    if (hasG(p, 'fire', 'detonate') && s.burnStacks >= 3) {
      aoeDamage(lobby, e.x, e.y, 110, 24, p.id);
      s.burnStacks = 0;
      s.burnT = 0;
    }
  }

  // ===== LIGHTNING =====
  if (isPath(p, 'lightning') && hasG(p, 'lightning', 'chargedRounds')) {
    p._glyphCharge = Math.min(1, (p._glyphCharge ?? 0) + 0.08);
    mult *= (1 + 0.10 * p._glyphCharge);
  }
  // "static" mark is the lightning core effect; only meaningful once a
  // branch node exists to make it matter, but we still track the mark/
  // discharge cycle whenever the player is on the lightning path so the
  // arc-jump/thunderclap/overload branch nodes have something to trigger.
  if (isPath(p, 'lightning')) {
    if (s.staticT <= 0) {
      s.staticT = 2.6;
      s.staticPrimed = true;
    } else if (s.staticPrimed) {
      s.staticPrimed = false;
      s.staticT = 0;

      e.hp -= 14;

      if (hasG(p, 'lightning', 'thunderclap')) {
        aoeDamage(lobby, e.x, e.y, 90, 10, p.id);
      }
      if (hasG(p, 'lightning', 'overload')) {
        e._stunT = Math.max(e._stunT ?? 0, 0.35);
      }
      if (hasG(p, 'lightning', 'arcJump') || hasG(p, 'lightning', 'forkedArc') || hasG(p, 'lightning', 'stormConductor')) {
        let jumps = hasG(p, 'lightning', 'stormConductor') ? 12 : (hasG(p, 'lightning', 'forkedArc') ? 2 : 1);
        let last = e;
        while (jumps-- > 0) {
          let best = null, bestD2 = 220 * 220;
          for (const o of lobby.enemies) {
            if (o === last || o.hp <= 0) continue;
            const dx = last.x - o.x, dy = last.y - o.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = o; }
          }
          if (!best) break;
          best.hp -= hasG(p, 'lightning', 'forkedArc') ? 7 : 10;
          best._lastHitBy = p.id;
          last = best;
        }
      }
    }
  }

  // ===== SPIRIT (soul bind) — track by enemy id, not object reference, so
  // stale/removed enemies don't linger and the snapshot stays clean =====
  if (isPath(p, 'spirit') && hasG(p, 'spirit', 'soulBind')) {
    const nowMs = Date.now();
    if (!p._linkA || !p._linkT || p._linkT < nowMs) {
      p._linkA = e.id; p._linkB = null; p._linkT = nowMs + 2400;
    } else if (!p._linkB && p._linkA !== e.id) {
      p._linkB = e.id; p._linkT = nowMs + 3000;
    }
  }

  // ===== WATER =====
  if (isPath(p, 'water')) {
    // core "Drench" always marks on a water-path hit (mirrors client core effect)
    s.drenchStacks = Math.min(3, s.drenchStacks + 1);
    s.drenchT = Math.max(s.drenchT, 4.2);
    e._slowT = Math.max(e._slowT ?? 0, s.drenchT);

    if (hasG(p, 'water', 'rippleShot')) {
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      e.x += (dx / d) * 18;
      e.y += (dy / d) * 18;
    }
    if (hasG(p, 'water', 'tidalRenewal')) {
      p._tidalHits = (p._tidalHits ?? 0) + 1;
      if (p._tidalHits % 10 === 0) {
        p.hp = Math.min(p.hpMax ?? 100, (p.hp ?? 100) + 5);
      }
    }
  }

  // ===== EARTH (bleed mark, no direct dmg here — see thornmail in contact loop) =====
  if (isPath(p, 'earth') && hasG(p, 'earth', 'jaggedEarth')) {
    e._bleedT = Math.max(e._bleedT ?? 0, 2.8);
  }

  // Soul Bind: copy a share of this hit's damage to the linked enemy
  const linkedDmg = (() => {
    if (isPath(p, 'spirit') && hasG(p, 'spirit', 'soulBind') && p._linkA && p._linkB) {
      const otherId = (p._linkA === e.id) ? p._linkB : (p._linkB === e.id ? p._linkA : null);
      if (!otherId) return null;
      const other = lobby.enemies.find(o => o.id === otherId);
      if (other && other !== e && other.hp > 0) return other;
    }
    return null;
  })();

  const finalDmg = baseDmg * mult;
  e.hp -= finalDmg;
  if (linkedDmg) {
    linkedDmg.hp -= finalDmg * 0.35;
    linkedDmg._lastHitBy = p.id;
  }
}

// Called whenever a PvE enemy dies in a lobby, so on-kill glyph effects
// (heal, essence, etc.) can fire. `killerId` may be null (e.g. died to a
// hazard/DoT with no clear last hitter beyond e._lastHitBy).
export function applyGlyphKill(lobby, e, killerId) {
  const pid = killerId ?? e._lastHitBy;
  if (!pid) return;
  const p = lobby.players.get(pid);
  if (!p) return;

  const wasBurning = (e._status && e._status.burnStacks > 0);

  if (isPath(p, 'fire') && hasG(p, 'fire', 'cauterise') && wasBurning) {
    p.hp = Math.min(p.hpMax ?? 100, (p.hp ?? 100) + 6);
  }
  if (isPath(p, 'fire') && hasG(p, 'fire', 'volcanicCore')) {
    p._fireKills = (p._fireKills ?? 0) + 1;
    if (p._fireKills % 5 === 0) {
      aoeDamage(lobby, e.x, e.y, 140, 30, pid);
    }
  }
}

// Contact-damage reflect for Earth's Thornmail — call from the enemy→player
// contact-damage loop with the raw damage the player is about to take.
export function thornmailReflect(lobby, p, e, incomingDmg) {
  if (!isPath(p, 'earth') || !hasG(p, 'earth', 'thornmail')) return;
  e.hp -= incomingDmg * 0.2;
  e._lastHitBy = p.id;
}
