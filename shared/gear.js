/**
 * GEAR TABLE — accumulating tiers, never individual items.
 *
 * A player owns one integer per slot. Buying upgrades that integer by exactly
 * one and charges the coins for the tier being entered. There is no inventory
 * grid, no drops that become items and no equip step.
 *
 * Tier 0 is "nothing equipped" and always costs nothing, so `tiers[n]` is the
 * tier a player at level `n` of that slot currently has.
 *
 * `mods` are real stat keys and become ONE `setModifier(ctx, player,
 * 'inventory', sum)`. `mult` is NOT a modifier — percentages on a single hit
 * are read by the damage-pipeline stage that `inventory` registers with
 * `combat`:
 *
 *   mult: { taken: -4, dealt: +6, meleeOnly: true }
 */

export const GEAR_SLOTS = ['weapon', 'armor', 'focus', 'boots']

export const GEAR = {
  weapon: {
    label: 'Sword',
    icon: '⚔',
    restrict: null,
    tiers: [
      {},
      { cost: 60, mods: { damage: +4 } },
      { cost: 150, mods: { damage: +9 } },
      { cost: 320, mods: { damage: +16 }, mult: { dealt: +6, meleeOnly: true } },
    ],
  },

  armor: {
    label: 'Armor',
    icon: '🛡',
    restrict: null,
    tiers: [
      {},
      { cost: 70, mods: { defense: +4, maxHp: +15 } },
      { cost: 170, mods: { defense: +9, maxHp: +35 } },
      { cost: 360, mods: { defense: +16, maxHp: +60 }, mult: { taken: -5 } },
    ],
  },

  focus: {
    label: 'Staff',
    icon: '🔮',
    restrict: ['mage'],
    tiers: [
      {},
      { cost: 80, mods: { spellPower: +8, cdr: +3 } },
      { cost: 190, mods: { spellPower: +18, cdr: +7 } },
      { cost: 400, mods: { spellPower: +32, cdr: +12 } },
    ],
  },

  boots: {
    label: 'Boots',
    icon: '👢',
    restrict: null,
    tiers: [
      {},
      { cost: 50, mods: { evasion: +3 }, mult: { taken: -4 } },
      { cost: 130, mods: { evasion: +7 }, mult: { taken: -7 } },
      { cost: 280, mods: { evasion: +12 }, mult: { taken: -11 } },
    ],
  },
}

/** All-zero tiers, the shape `player.ext.inventory.tiers` starts at. */
export function emptyTiers() {
  return Object.fromEntries(GEAR_SLOTS.map((slot) => [slot, 0]))
}

/** True when this class may buy into this slot at all. */
export function canUseSlot(slot, cls) {
  const def = GEAR[slot]
  if (!def) return false
  return !def.restrict || def.restrict.includes(cls)
}

/** Cost of the next tier, or null when the slot is maxed or restricted. */
export function nextTierCost(slot, currentTier, cls) {
  if (!canUseSlot(slot, cls)) return null
  const next = GEAR[slot].tiers[(currentTier ?? 0) + 1]
  return next?.cost ?? null
}

/** Sums the `mods` of every owned tier into one flat stat object. */
export function sumGearMods(tiers) {
  const total = {}
  for (const slot of GEAR_SLOTS) {
    const owned = tiers?.[slot] ?? 0
    for (let tier = 1; tier <= owned; tier++) {
      for (const [key, value] of Object.entries(GEAR[slot].tiers[tier]?.mods ?? {})) {
        total[key] = (total[key] ?? 0) + value
      }
    }
  }
  return total
}

/** Sums the non-stat `mult` fields — the damage pipeline's input, not a modifier. */
export function sumGearMults(tiers) {
  const total = { taken: 0, dealt: 0, meleeDealt: 0 }
  for (const slot of GEAR_SLOTS) {
    const owned = tiers?.[slot] ?? 0
    for (let tier = 1; tier <= owned; tier++) {
      const mult = GEAR[slot].tiers[tier]?.mult
      if (!mult) continue
      total.taken += mult.taken ?? 0
      if (mult.meleeOnly) total.meleeDealt += mult.dealt ?? 0
      else total.dealt += mult.dealt ?? 0
    }
  }
  return total
}
