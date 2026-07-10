/**
 * Shared verb: imported rollout-weight normalization (qfg-wis6.11).
 *
 * Stored weighted values must satisfy the weight predicate qfg-verify
 * enforces: either an even split (all weights equal and > 0) or percentages
 * summing to MAX_WEIGHT. All-equal imports are the canonical even-split
 * encoding and pass through verbatim (Launch's 1/1 rollouts are intended
 * data, not a bug). Anything else is scaled to sum exactly MAX_WEIGHT via
 * largest remainder — ties go to the earliest index — and reported. A zero
 * (or negative) total becomes an even split.
 */

export const MAX_WEIGHT = 100_000

export interface NormalizedWeights {
  /** Human-readable report line naming the original ratio and the action. */
  detail: string
  /** The predicate-satisfying replacement weights, same length as input. */
  weights: number[]
}

/** Returns null when the weights already satisfy the predicate (import verbatim). */
export function normalizeImportedWeights(weights: number[]): NormalizedWeights | null {
  if (weights.length === 0) return null

  const clamped = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const total = clamped.reduce((a, b) => a + b, 0)

  const allEqualNonZero = clamped[0] > 0 && clamped.every((w) => w === clamped[0])
  if (allEqualNonZero && clamped.every((w, i) => w === weights[i])) return null

  if (total <= 0) {
    return {
      weights: weights.map(() => 1),
      detail: `rollout weights [${weights.join(', ')}] have zero total — imported as an even split (all ones)`,
    }
  }

  if (total === MAX_WEIGHT && clamped.every((w, i) => w === weights[i] && Number.isInteger(w))) return null

  // Largest remainder: floor each exact share, then hand the missing units
  // to the largest fractional remainders, ties to the earliest index.
  const exact = clamped.map((w) => (w / total) * MAX_WEIGHT)
  const floors = exact.map((x) => Math.floor(x))
  let missing = MAX_WEIGHT - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({fraction: x - Math.floor(x), i}))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  for (const {i} of order) {
    if (missing <= 0) break
    floors[i] += 1
    missing -= 1
  }

  return {
    weights: floors,
    detail: `rollout weights [${weights.join(', ')}] (sum ${total}) normalized to [${floors.join(', ')}] to sum ${MAX_WEIGHT}`,
  }
}
