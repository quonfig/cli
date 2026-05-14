/**
 * Shared verb: provider clause operator + `negate` flag → Quonfig criterion
 * operator, or a skip reason.
 *
 * This is part of the `quonfig-target/` verb library (plan §3.1, D1) — written
 * once, consumed by every provider's `translate.ts`. The mapping table and the
 * negation rules below are LaunchDarkly-shaped today, but the *shape* of the
 * verb (op + negate → operator | skip) is provider-independent; a second
 * provider extends the table rather than reinventing the dispatch.
 */

/** Quonfig criterion operators — mirrors `OperatorSchema` in app-quonfig's config-schemas.ts. */
export type QuonfigOperator =
  | 'ALWAYS_TRUE'
  | 'IN_SEG'
  | 'IS_NOT_PRESENT'
  | 'IS_PRESENT'
  | 'NOT_IN_SEG'
  | 'PROP_AFTER'
  | 'PROP_BEFORE'
  | 'PROP_CONTAINS_ONE_OF'
  | 'PROP_DOES_NOT_CONTAIN_ONE_OF'
  | 'PROP_DOES_NOT_END_WITH_ONE_OF'
  | 'PROP_DOES_NOT_MATCH'
  | 'PROP_DOES_NOT_START_WITH_ONE_OF'
  | 'PROP_ENDS_WITH_ONE_OF'
  | 'PROP_GREATER_THAN'
  | 'PROP_GREATER_THAN_OR_EQUAL'
  | 'PROP_IS_NOT_ONE_OF'
  | 'PROP_IS_ONE_OF'
  | 'PROP_LESS_THAN'
  | 'PROP_LESS_THAN_OR_EQUAL'
  | 'PROP_MATCHES'
  | 'PROP_SEMVER_EQUAL'
  | 'PROP_SEMVER_GREATER_THAN'
  | 'PROP_SEMVER_LESS_THAN'
  | 'PROP_STARTS_WITH_ONE_OF'

export type OperatorMapping = {operator: QuonfigOperator} | {reason: string; skip: true}

/**
 * Operators that have a direct negated form in Quonfig. `negate: true` simply
 * selects the negated operator — semantics-preserving, always converted.
 */
const NEGATABLE: Record<string, {negated: QuonfigOperator; plain: QuonfigOperator}> = {
  contains: {negated: 'PROP_DOES_NOT_CONTAIN_ONE_OF', plain: 'PROP_CONTAINS_ONE_OF'},
  endsWith: {negated: 'PROP_DOES_NOT_END_WITH_ONE_OF', plain: 'PROP_ENDS_WITH_ONE_OF'},
  in: {negated: 'PROP_IS_NOT_ONE_OF', plain: 'PROP_IS_ONE_OF'},
  matches: {negated: 'PROP_DOES_NOT_MATCH', plain: 'PROP_MATCHES'},
  segmentMatch: {negated: 'NOT_IN_SEG', plain: 'IN_SEG'},
  startsWith: {negated: 'PROP_DOES_NOT_START_WITH_ONE_OF', plain: 'PROP_STARTS_WITH_ONE_OF'},
}

/**
 * Comparison / date / semver operators. Quonfig has no negated form of any of
 * these (decision D3). `negate: false` converts directly; `negate: true` is
 * skip + report — an algebraic flip would need a within-rule OR for the
 * missing-attribute case, which Quonfig cannot express.
 */
const COMPARISON_ONLY: Record<string, QuonfigOperator> = {
  after: 'PROP_AFTER',
  before: 'PROP_BEFORE',
  greaterThan: 'PROP_GREATER_THAN',
  greaterThanOrEqual: 'PROP_GREATER_THAN_OR_EQUAL',
  lessThan: 'PROP_LESS_THAN',
  lessThanOrEqual: 'PROP_LESS_THAN_OR_EQUAL',
  semVerEqual: 'PROP_SEMVER_EQUAL',
  semVerGreaterThan: 'PROP_SEMVER_GREATER_THAN',
  semVerLessThan: 'PROP_SEMVER_LESS_THAN',
}

/**
 * Map a LaunchDarkly clause `op` + `negate` to a Quonfig operator.
 *
 * Returns `{skip: true, reason}` for clauses v1 cannot honor:
 *  - negated comparison/date/semver ops (D3)
 *  - `applicationVersionSupported` (no Quonfig equivalent)
 *  - any operator not in the LaunchDarkly enum we recognize
 */
export function mapLaunchDarklyOperator(op: string, negate: boolean): OperatorMapping {
  const negatable = NEGATABLE[op]
  if (negatable) {
    return {operator: negate ? negatable.negated : negatable.plain}
  }

  const comparison = COMPARISON_ONLY[op]
  if (comparison) {
    if (negate) {
      return {
        reason:
          `negated comparison operator "${op}" — Quonfig has no negated form and no within-rule OR, ` +
          `so an algebraic flip is unsafe (missing-attribute trap). Recreate this clause by hand.`,
        skip: true,
      }
    }

    return {operator: comparison}
  }

  if (op === 'applicationVersionSupported') {
    return {
      reason: `operator "applicationVersionSupported" has no Quonfig equivalent`,
      skip: true,
    }
  }

  return {reason: `unrecognized LaunchDarkly operator "${op}"`, skip: true}
}
