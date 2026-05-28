// Safety nudge for `qfg delete` — catches the wrong-order cleanup mistake
// before it ships. If a flag still has eval traffic in the last 24h, we prompt
// the user with "did you mean `qfg cleanup remove` first?" before letting
// `qfg delete` proceed to the destructive typed-slug confirmation.
//
// This module is the testable core; src/commands/delete.ts wires the real
// apiClient + confirmYesNo to it.

export interface ConfigSparklineRow {
  counts: number[]
  days: string[]
  environment: string
}

interface SparklinesOk {
  ok: true
  rows: ConfigSparklineRow[]
}

interface SparklinesErr {
  error: string
  ok: false
}

export type SparklinesResult = SparklinesErr | SparklinesOk

export interface SafetyNudgeDeps {
  fetchSparklines: () => Promise<SparklinesResult>
  key: string
  prompt: (message: string) => Promise<boolean>
  warn: (message: string) => void
}

export interface SafetyNudgeResult {
  evals24h: number
  proceed: boolean
  telemetryFailed: boolean
}

function startOfDayUtcMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/**
 * Sum the eval counts in today's UTC calendar bucket across all environment
 * rows in a configSparklines response. Matches the `evals_24h` semantics used
 * in `qfg cleanup remove` (today-only bucket from the daily-grouped sparkline).
 */
export function countEvalsLast24h(rows: ConfigSparklineRow[]): number {
  const todayMs = startOfDayUtcMs(new Date())
  let total = 0
  for (const row of rows) {
    for (const [i, day] of row.days.entries()) {
      const count = row.counts[i] ?? 0
      if (count <= 0) continue
      const dayMs = Date.parse(`${day}T00:00:00Z`)
      if (Number.isNaN(dayMs)) continue
      const daysAgo = Math.round((todayMs - dayMs) / 86_400_000)
      if (daysAgo !== 0) continue
      total += count
    }
  }

  return total
}

export async function checkRecentEvalsSafetyNudge(deps: SafetyNudgeDeps): Promise<SafetyNudgeResult> {
  const {fetchSparklines, key, prompt, warn} = deps

  const sparkResult = await fetchSparklines()
  if (!sparkResult.ok) {
    warn(`Could not check recent evals for ${key} (${sparkResult.error}). Proceeding anyway.`)
    return {evals24h: 0, proceed: true, telemetryFailed: true}
  }

  const evals24h = countEvalsLast24h(sparkResult.rows)
  if (evals24h === 0) {
    return {evals24h: 0, proceed: true, telemetryFailed: false}
  }

  const message =
    `This flag still has ${evals24h} eval(s) in the last 24h. ` +
    `Did you mean \`qfg cleanup remove ${key}\` first to get the call sites out? [y/N] `
  const confirmed = await prompt(message)
  return {evals24h, proceed: confirmed, telemetryFailed: false}
}
