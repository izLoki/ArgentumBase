/**
 * MONSTER TABLE — pure data, mirroring shared/spells.js.
 *
 * Four types, each with a different reason to exist: the golem is a wall, the
 * dragon is the real threat, the skeleton is an obstacle, and the bat is a
 * nuisance that never stays to fight.
 *
 * WHY THIS IS SHARED. The snapshot sends a type INDEX, not a name — mobs are
 * the densest thing riding it after projectiles — so the client needs the same
 * ordered roster to turn `2` back into a skeleton, plus the `look` block to
 * draw it. A second copy on the client would drift; `server/systems/npc.js`
 * imports this one and re-exports it, and remains the only writer of mob state.
 *
 * UNITS. `aggro` is in BLOCKS, like every gameplay distance in this project —
 * `blocksToTiles()` before comparing it against coordinates. `moveMs` is per
 * BLOCK too: a mob stepping one tile at a time moves every `moveMs /
 * BLOCK_TILES`, and it is authored rather than derived from `agi` because mob
 * movement does not go through the player `MOVE` handler.
 *
 * Mobs carry an `attrs` block on the same [0, ATTR_MAX] scale as players, so
 * `spellDamage()` and `effectiveCooldown()` work on them unchanged — a mob is
 * just another caster handle. `hp` is authored rather than derived, because a
 * mob has no level curve to interpolate.
 */

/**
 * @typedef {Object} MobType
 * @property {string} name
 * @property {number} hp
 * @property {Record<string, number>} attrs   str/agi/int/con, [0, 150]
 * @property {Object} stats                   derived stats a mob is born with
 * @property {number} moveMs                  per BLOCK walked
 * @property {number} aggro                   BLOCKS
 * @property {'brawler'|'hitAndRun'} behaviour
 * @property {number} weight                  relative spawn frequency
 * @property {string[]} spells                priority order, see `ARENA.md` §5.2
 * @property {Object} look                    client-side only; the server never reads it
 */

/** @type {Record<string, MobType>} */
export const MOB_TYPES = {
  dragon: {
    name: 'Dragon',
    hp: 280,
    attrs: { str: 70, agi: 45, int: 120, con: 100 },
    stats: { damage: +1, defense: 6, evasion: 0 },
    moveMs: 400,
    aggro: 10,
    behaviour: 'brawler',
    weight: 1,
    spells: ['fireBreath', 'tailSweep', 'clawSwipe'],
    look: { color: 0x8f3a2a, glyph: '🐉', scale: 1.6 },
  },

  golem: {
    name: 'Golem',
    hp: 240,
    attrs: { str: 130, agi: 10, int: 5, con: 130 },
    stats: { damage: +6, defense: 12, evasion: 0 },
    moveMs: 560,
    aggro: 6,
    behaviour: 'brawler',
    weight: 3,
    spells: ['boulder', 'stoneFist'],
    look: { color: 0x6f6a5e, glyph: '🗿', scale: 1.35 },
  },

  skeleton: {
    name: 'Skeleton',
    hp: 80,
    attrs: { str: 20, agi: 35, int: 45, con: 30 },
    stats: { damage: 0, defense: 3, evasion: 0 },
    moveMs: 340,
    aggro: 8,
    behaviour: 'brawler',
    weight: 4,
    spells: ['chill'],
    look: { color: 0xd8d3c4, glyph: '💀', scale: 1 },
  },

  bat: {
    name: 'Bat',
    hp: 45,
    attrs: { str: 10, agi: 120, int: 60, con: 15 },
    stats: { damage: 0, defense: 1, evasion: 0 },
    moveMs: 200,
    aggro: 9,
    behaviour: 'hitAndRun',
    weight: 4,
    spells: ['venomBite'],
    look: { color: 0x4a3b57, glyph: '🦇', scale: 0.85 },
  },
}

/**
 * Stable order, so the snapshot can send a type index instead of a string.
 *
 * Append-only, for the same reason `SPELL_IDS` is: a row inserted in the middle
 * renumbers every type, and a client mid-snapshot would draw the wrong monster.
 */
export const MOB_TYPE_IDS = Object.keys(MOB_TYPES)

/** The definition, or null for an unknown type. Never throws on bad input. */
export function mobDef(type) {
  return MOB_TYPES[type] ?? null
}

/** Wire index of a mob type, or -1. */
export function mobIndex(type) {
  return MOB_TYPE_IDS.indexOf(type)
}

/** The type behind a wire index, or null. */
export function mobFromIndex(index) {
  return MOB_TYPE_IDS[index] ?? null
}

/** Total spawn weight, for the roll in the spawner. */
export function totalMobWeight() {
  let total = 0
  for (const def of Object.values(MOB_TYPES)) total += def.weight ?? 0
  return total
}
