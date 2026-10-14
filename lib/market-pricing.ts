/** Display/reference probabilities, never executable prices. Missing marks use neutral weights. */
export function marketProbabilities(marks: readonly (number | null | undefined)[], eligible: readonly boolean[] = marks.map(() => true)): number[] {
  const count = eligible.filter(Boolean).length;
  if (!count) return marks.map(() => 0);
  const weights = marks.map((mark, i) => !eligible[i] ? 0
    : mark == null || !Number.isFinite(mark) || mark < 0 ? 1 / count : mark);
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value, i) => total > 0 ? value / total : eligible[i] ? 1 / count : 0);
}

/** Largest remainders make the displayed tenths of a percent total exactly 100.0%. */
export function probabilityUnits(probabilities: readonly number[], totalUnits = 1000): number[] {
  if (!probabilities.length) return [];
  const normalized = marketProbabilities(probabilities);
  const raw = normalized.map(p => p * totalUnits);
  const units = raw.map(Math.floor);
  const priority = raw.map((value, i) => ({ i, remainder: value - units[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let remaining = totalUnits - units.reduce((sum, n) => sum + n, 0);
  for (let i = 0; remaining > 0; i++, remaining--) units[priority[i % priority.length].i]++;
  return units;
}

export const MAKER_LEVEL_QUANTITIES = [100, 150, 200, 250, 300, 400] as const;
export type MakerOrder = { outcome: number; side: 'buy' | 'sell'; quantity: number; priceTicks: number };

/** Integer-cent centers sum to $1; every bid is at/below its center and ask at/above. */
export function coherentMakerOrders(weights: readonly number[], eligible: readonly boolean[], spread: number): MakerOrder[] {
  // One remaining player ends the hand; there is no meaningful open two-sided market.
  if (eligible.filter(Boolean).length < 2) return [];
  const normalized = marketProbabilities(weights, eligible);
  const centers = probabilityUnits(normalized, 100);
  for (let i = 0; i < centers.length; i++) {
    if (!eligible[i] || centers[i] > 0) continue;
    const donor = centers.reduce((best, value, index) => value > centers[best] ? index : best, 0);
    if (centers[donor] > 1) { centers[donor]--; centers[i]++; }
  }
  return centers.flatMap((center, outcome) => !eligible[outcome] ? [] : MAKER_LEVEL_QUANTITIES.flatMap((quantity, level) => [
    { outcome, side: 'buy' as const, quantity, priceTicks: Math.max(1, Math.min(99, center - spread - level * 2)) },
    { outcome, side: 'sell' as const, quantity, priceTicks: Math.max(1, Math.min(99, center + spread + level * 2)) },
  ]));
}
