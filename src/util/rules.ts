/**
 * Rule helpers shared by the CLI's writers (`set-default`, `set-rollout`,
 * `log-level`) and readers (`info`, `cleanup status`) — beads qfg-qjdm and
 * qfg-9kr8.
 *
 * The CLI cannot import app-quonfig code, so this file is a deliberate,
 * small mirror of the server's rulebook. Keep the semantics byte-identical
 * with:
 *   - app-quonfig src/lib/domain/rule-display.ts  → isCatchAllRule
 *   - app-quonfig src/lib/public-api/write-scope.ts → countTargetingRules
 *   - app-quonfig src/lib/public-api/log-level-write.ts → upsertFallbackRule
 * Both surfaces write the same documents; a second, subtly different
 * rulebook is a correctness hazard, not a style problem.
 */

export type Criterion = {operator?: unknown; [key: string]: unknown}
export type Rule = {criteria?: Criterion[]; value?: unknown; [key: string]: unknown}
export type EnvRules = {id: string; rules?: Rule[]}
export type ScopedDocument = {default?: {rules?: Rule[]}; environments?: EnvRules[]}

/** A fresh unconditional rule carrying `value`. */
export function catchAllRule(value: unknown): Rule {
  return {criteria: [{operator: 'ALWAYS_TRUE'}], value}
}

/**
 * THE ONE DEFINITION of "is this rule unconditional" (qfg-gv54).
 *
 * A catch-all — the base-case rule that serves everyone in its scope — has
 * two live JSON spellings, and every SDK evaluator treats them identically:
 *
 *   {criteria: [{operator: 'ALWAYS_TRUE'}]}  ← UI, API, MCP, `qfg create`
 *   {criteria: []}                           ← older `qfg set-default` writes
 *
 * Both are in production data and neither is being backfilled (Jeff,
 * 2026-09-02), so every READER accepts both. Criteria are ANDed, so one
 * conditional criterion makes the whole rule conditional.
 *
 * Fails CLOSED: anything unreadable as a rule (no `criteria` key, not an
 * object) is NOT a catch-all — the same choice app-quonfig's
 * `isCatchAllRuleUnknown` makes for raw parsed JSON. On the write path that
 * means a malformed rule is left alone and a fresh fallback is appended,
 * rather than a malformed rule being silently overwritten.
 */
export function isCatchAllRule(rule: unknown): boolean {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return false
  const {criteria} = rule as {criteria?: unknown}
  if (!Array.isArray(criteria)) return false
  // An empty list satisfies `every` vacuously — that IS the `criteria: []`
  // spelling — so this one expression covers both shapes.
  return criteria.every(
    (criterion) =>
      typeof criterion === 'object' &&
      criterion !== null &&
      (criterion as {operator?: unknown}).operator === 'ALWAYS_TRUE',
  )
}

/**
 * How many real TARGETING rules a scope holds.
 *
 * A targeted scope is conventionally `[…targeting rules, catch-all]`: the
 * trailing unconditional rule is the scope's fallback, not a rule that
 * targets anyone, so it is discounted. ONLY a trailing catch-all is — an
 * unconditional rule anywhere earlier shadows every rule after it, which is
 * a targeting decision in its own right and stays counted.
 */
export function countTargetingRules(rules: Rule[]): number {
  const last = rules.at(-1)
  return last !== undefined && isCatchAllRule(last) ? rules.length - 1 : rules.length
}

/**
 * Set the scope's fallback value WITHOUT disturbing its targeting rules:
 * the first catch-all's value is replaced in place (criteria untouched — an
 * existing bare `criteria: []` fallback keeps its spelling, exactly as the
 * server does), and if the scope has no catch-all at all a fresh
 * ALWAYS_TRUE rule is appended at the end. Never mutates `rules`.
 */
export function upsertFallbackRule(rules: Rule[], value: unknown): Rule[] {
  const index = rules.findIndex((rule) => isCatchAllRule(rule))
  if (index === -1) return [...rules, catchAllRule(value)]
  const next = [...rules]
  next[index] = {...next[index], value}
  return next
}

/**
 * The rules a write should start from for one scope.
 *
 * `envName` undefined (or empty) means the document's `default` block, which
 * always exists and is never seeded. A named environment with no block of
 * its own inherits `default.rules` at evaluation time, so writing it starts
 * from a DEEP CLONE of those rules — the same shape the UI produces when an
 * environment stops inheriting. Starting from `[]` instead would silently
 * drop the inherited targeting for that environment.
 *
 * `seeded` is true only when rules were actually copied, so callers do not
 * report a copy that moved nothing.
 */
export function seedScopeRules(config: ScopedDocument, envName?: string): {rules: Rule[]; seeded: boolean} {
  const defaultRules = config.default?.rules ?? []
  if (!envName) return {rules: defaultRules, seeded: false}

  const env = (config.environments ?? []).find((e) => e.id === envName)
  if (env) return {rules: env.rules ?? [], seeded: false}

  const cloned = structuredClone(defaultRules)
  return {rules: cloned, seeded: cloned.length > 0}
}

/** The environments array with `envName`'s rules replaced, appending the entry when it has none. */
export function upsertEnvRules(envs: EnvRules[], envName: string, rules: Rule[]): EnvRules[] {
  const index = envs.findIndex((e) => e.id === envName)
  if (index === -1) return [...envs, {id: envName, rules}]
  const next = [...envs]
  next[index] = {...next[index], rules}
  return next
}

// ── Reporting ────────────────────────────────────────────────────────
//
// One wording, used by every verb that writes a fallback, so `set-default`,
// `set-rollout` and the public API cannot drift apart in what they claim to
// have done.

/** '<env> had no rules of its own; copied them from default.' */
export function seededFromDefaultNote(envName: string): string {
  return `${envName} had no rules of its own; copied them from default.`
}

/** What a surgical write kept. Empty when the scope held no targeting rules. */
export function keptTargetingNote(count: number): string {
  if (count === 0) return ''
  return (
    `Kept ${count} targeting rule(s); matched users still receive their targeted value. ` +
    `To set for everyone, add --replace-targeting.`
  )
}

/** What a --replace-targeting write destroyed, and where to find it again. */
export function replacedTargetingNote(count: number, previousCommitSha: string): string {
  if (count === 0) return `Previous version ${previousCommitSha}.`
  return `Replaced ${count} targeting rule(s); previous version ${previousCommitSha}.`
}
