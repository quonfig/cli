/**
 * `qfg cr wait <n|branch>` (qfg-5bjew.37, step3-decomposition.md child 9).
 * Polls `changeRequests.get` until the request settles:
 *
 *   0    merged
 *   2    closed
 *   4    blocked by a conflict with main (prints the fix)
 *   124  timeout (the request is still open)
 *
 * There is no exit 3: there is no review step (Deferred). Any other block
 * (for example "someone with rights must merge it") keeps waiting, since
 * that is exactly what the caller is waiting for. Dependency-injected (clock,
 * sleep, get) so the sequence is testable without real time.
 */

import type {ChangeRequestDetail} from './types.js'

import {ChangeRequestApiError} from './client.js'
import {CrCommandError} from './merge-flow.js'
import {conflictFix} from './render.js'

export type WaitOutcome = 'closed' | 'conflict' | 'merged' | 'timeout'

export const WAIT_EXIT_CODES: Record<WaitOutcome, number> = {merged: 0, closed: 2, conflict: 4, timeout: 124}

// The fix text lives with the rest of the cr rendering (qfg-5bjew.39).
export {CLONE_CONFLICT_FIX, crConflictFix} from './render.js'

export interface WaitDeps {
  get(): Promise<ChangeRequestDetail>
  now(): number
  sleep(ms: number): Promise<void>
  /** A transient failure that is being retried. */
  warn(line: string): void
}

export interface WaitResult {
  detail: ChangeRequestDetail
  exitCode: number
  fix?: string
  outcome: WaitOutcome
}

const UNITS: Record<string, number> = {h: 3_600_000, m: 60_000, ms: 1, s: 1000}

/** `30m`, `10s`, `1h`, `500ms`, or bare seconds -> milliseconds. */
export function parseDuration(raw: string, flag: string): number {
  const m = /^\s*(\d+)\s*(ms|s|m|h)?\s*$/i.exec(raw)
  if (!m) throw new CrCommandError(`${flag}: expected a duration like 30m, 10s, 1h or 500ms, got ${raw}`)
  return Number.parseInt(m[1], 10) * UNITS[(m[2] ?? 's').toLowerCase()]
}

function settled(detail: ChangeRequestDetail): Omit<WaitResult, 'detail'> | undefined {
  if (detail.status === 'merged') return {exitCode: WAIT_EXIT_CODES.merged, outcome: 'merged'}
  if (detail.status === 'closed') return {exitCode: WAIT_EXIT_CODES.closed, outcome: 'closed'}
  if (detail.blockedBy?.reason === 'conflict') {
    return {
      exitCode: WAIT_EXIT_CODES.conflict,
      fix: conflictFix(detail),
      outcome: 'conflict',
    }
  }

  return undefined
}

/** A failure worth retrying: a 5xx or 429, or no HTTP answer at all. */
function isTransient(error: unknown): boolean {
  if (error instanceof ChangeRequestApiError) return error.status >= 500 || error.status === 429
  return error instanceof TypeError
}

export async function runCrWait(input: {intervalMs: number; timeoutMs: number}, deps: WaitDeps): Promise<WaitResult> {
  const start = deps.now()
  let last: ChangeRequestDetail | undefined
  let lastError: unknown
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      last = await deps.get()
      lastError = undefined
      const done = settled(last)
      if (done) return {...done, detail: last}
    } catch (error) {
      if (!isTransient(error)) throw error
      lastError = error
      deps.warn(
        `Could not check the change request (${error instanceof Error ? error.message : String(error)}); retrying.`,
      )
    }

    const remaining = input.timeoutMs - (deps.now() - start)
    if (remaining <= 0) {
      // Never reached the server at all: report that, not a fake timeout.
      if (last === undefined) throw lastError
      return {detail: last, exitCode: WAIT_EXIT_CODES.timeout, outcome: 'timeout'}
    }

    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(Math.min(input.intervalMs, remaining))
  }
}
