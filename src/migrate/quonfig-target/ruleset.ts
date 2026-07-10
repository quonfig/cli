/**
 * Shared verb: collapse a provider's targeting model into Quonfig's ordered,
 * first-match-wins rule list.
 *
 * Part of the `quonfig-target/` verb library (plan §3.1, D1). The hard part of
 * every converter is topology translation into Quonfig's specific shape — no
 * "flag off" toggle, no individual-target primitive, no within-rule OR. These
 * verbs do the LaunchDarkly collapse; a second provider with a different
 * topology composes them differently.
 */

import {resolveKey} from '../key-rewriter.js'
import type {ConversionReport} from './report.js'
import {type QuonfigOperator, mapLaunchDarklyOperator} from './operators.js'
import {type QuonfigValue, type QuonfigValueType, toQuonfigValue} from './values.js'
import {normalizeImportedWeights} from './weights.js'

// ── Quonfig output shapes (subset of app-quonfig's config-schemas.ts) ──────

export interface QuonfigCriterion {
  operator: QuonfigOperator | 'ALWAYS_TRUE'
  propertyName?: string
  valueToMatch?: QuonfigValue
}

export interface QuonfigWeightedValues {
  type: 'weighted_values'
  value: {
    hashByPropertyName: string
    weightedValues: Array<{value: QuonfigValue; weight: number}>
  }
}

export type QuonfigRuleValue = QuonfigValue | QuonfigWeightedValues

export interface QuonfigRule {
  criteria: QuonfigCriterion[]
  value: QuonfigRuleValue
}

// ── Provider-shaped inputs (kept structural so this verb is import-light) ──

interface SourceClause {
  attribute: string
  contextKind?: string
  negate?: boolean
  op: string
  values: unknown[]
}

interface SourceRollout {
  bucketBy?: string
  contextKind?: string
  kind?: string
  seed?: number
  variations: Array<{variation: number; weight: number}>
}

interface SourceRule {
  _id?: string
  clauses: SourceClause[]
  rollout?: SourceRollout
  variation?: number
}

interface SourceTarget {
  contextKind?: string
  values: string[]
  variation: number
}

interface SourceVariationOrRollout {
  rollout?: SourceRollout
  variation?: number
}

interface SourceFlagEnvironment {
  contextTargets?: SourceTarget[]
  fallthrough?: SourceVariationOrRollout
  offVariation?: number
  on: boolean
  prerequisites?: Array<{key: string; variation: number}>
  rules?: SourceRule[]
  targets?: SourceTarget[]
}

export interface RulesetContext {
  report: ConversionReport
  /** Source flag/segment key — used for precise report entries. */
  sourceKey: string
  /** The flag's resolved Quonfig value type. */
  valueType: QuonfigValueType
  /** Raw variation values, indexed as the provider indexes them. */
  variationValues: unknown[]
}

const ALWAYS_TRUE: QuonfigCriterion = {operator: 'ALWAYS_TRUE'}

/** Operators whose `valueToMatch` is a `string_list` of every clause value. */
const STRING_LIST_OPERATORS = new Set<QuonfigOperator>([
  'PROP_CONTAINS_ONE_OF',
  'PROP_DOES_NOT_CONTAIN_ONE_OF',
  'PROP_DOES_NOT_END_WITH_ONE_OF',
  'PROP_DOES_NOT_START_WITH_ONE_OF',
  'PROP_ENDS_WITH_ONE_OF',
  'PROP_IS_NOT_ONE_OF',
  'PROP_IS_ONE_OF',
  'PROP_STARTS_WITH_ONE_OF',
])

const NUMERIC_OPERATORS = new Set<QuonfigOperator>([
  'PROP_GREATER_THAN',
  'PROP_GREATER_THAN_OR_EQUAL',
  'PROP_LESS_THAN',
  'PROP_LESS_THAN_OR_EQUAL',
])

/**
 * LaunchDarkly attribute → Quonfig property name. The context kind becomes a
 * namespace prefix (plan §5.1: `organization` + `plan` → `organization.plan`),
 * defaulting to `user`. A nested JSON-pointer attribute (`/address/city`)
 * becomes a dotted path (`address.city`).
 */
export function normalizeAttribute(contextKind: string | undefined, attribute: string): string {
  const kind = contextKind && contextKind.length > 0 ? contextKind : 'user'
  const dotted = attribute.replace(/^\//, '').replaceAll('/', '.')
  return `${kind}.${dotted}`
}

/** Build a `valueToMatch` typed value for a non-presence, non-segment clause. */
function valueToMatchFor(operator: QuonfigOperator, clause: SourceClause, ctx: RulesetContext): QuonfigValue {
  if (STRING_LIST_OPERATORS.has(operator)) {
    return {type: 'string_list', value: clause.values.map(String)}
  }

  if (operator === 'IN_SEG' || operator === 'NOT_IN_SEG') {
    if (clause.values.length > 1) {
      ctx.report.add(
        'skipped-rule',
        ctx.sourceKey,
        `segmentMatch clause listed ${clause.values.length} segments; Quonfig IN_SEG matches one — only "${String(
          clause.values[0],
        )}" kept, the rest dropped`,
      )
    }

    // qfg-6na9.3: this value is a referenced segment KEY — resolve it through
    // the per-run rewriter so a sanitized/disambiguated segment key stays in
    // sync with the IN_SEG rules pointing at it (no dangling targeting).
    return {type: 'string', value: resolveKey(String(clause.values[0] ?? ''))}
  }

  if (operator === 'PROP_MATCHES' || operator === 'PROP_DOES_NOT_MATCH') {
    if (clause.values.length > 1) {
      ctx.report.add(
        'skipped-rule',
        ctx.sourceKey,
        `regex clause listed ${clause.values.length} patterns; Quonfig PROP_MATCHES takes one — only the first kept`,
      )
    }

    return {type: 'string', value: String(clause.values[0] ?? '')}
  }

  if (NUMERIC_OPERATORS.has(operator)) {
    const raw = clause.values[0]
    const num = typeof raw === 'number' ? raw : Number(raw)
    return {type: Number.isInteger(num) ? 'int' : 'double', value: num}
  }

  if (operator === 'PROP_BEFORE' || operator === 'PROP_AFTER') {
    const raw = clause.values[0]
    // LD before/after take an epoch-ms number or an RFC3339 string; the SDK's
    // dateToMillis accepts both, so pass the native shape straight through.
    return typeof raw === 'number' ? {type: 'int', value: raw} : {type: 'string', value: String(raw)}
  }

  // Semver operators — the SDK requires a string value.
  return {type: 'string', value: String(clause.values[0] ?? '')}
}

/**
 * Map one provider clause to a Quonfig criterion, or `null` when the clause's
 * operator has no v1 mapping (D3 — negated comparisons, applicationVersion…).
 * A null result means the whole containing rule must be dropped: keeping a
 * partial AND would silently broaden targeting.
 */
export function clauseToCriterion(clause: SourceClause, ctx: RulesetContext): QuonfigCriterion | null {
  const mapping = mapLaunchDarklyOperator(clause.op, Boolean(clause.negate))
  if ('skip' in mapping) {
    ctx.report.add('skipped-rule', ctx.sourceKey, `clause on "${clause.attribute}" skipped: ${mapping.reason}`)
    return null
  }

  const {operator} = mapping
  // Segment matches key off valueToMatch alone — LD's pseudo-attribute
  // ("segmentMatch") must not leak in as a propertyName (qfg-gc3u).
  const criterion: QuonfigCriterion =
    operator === 'IN_SEG' || operator === 'NOT_IN_SEG'
      ? {operator}
      : {operator, propertyName: normalizeAttribute(clause.contextKind, clause.attribute)}
  criterion.valueToMatch = valueToMatchFor(operator, clause, ctx)
  return criterion
}

/**
 * Build a Quonfig rule from a provider rule's clauses (AND semantics) plus its
 * served value. Returns `null` when any clause cannot be mapped — the rule is
 * dropped wholesale and reported, rather than silently broadened.
 */
export function buildRule(clauses: SourceClause[], value: QuonfigRuleValue, ctx: RulesetContext): QuonfigRule | null {
  const criteria: QuonfigCriterion[] = []
  for (const clause of clauses) {
    const criterion = clauseToCriterion(clause, ctx)
    if (criterion === null) return null
    criteria.push(criterion)
  }

  // A rule with no clauses matches everyone — represent that as ALWAYS_TRUE.
  return {criteria: criteria.length > 0 ? criteria : [ALWAYS_TRUE], value}
}

/** Resolve a variation index to its typed Quonfig value. */
function variationValue(index: number, ctx: RulesetContext): QuonfigValue {
  const raw = ctx.variationValues[index]
  return toQuonfigValue(raw, ctx.valueType)
}

/**
 * Convert a provider rollout to a Quonfig `weighted_values`. The experiment
 * framing (`kind: "experiment"` + `seed`) is dropped + reported (plan §5.4),
 * and every rollout is recorded as re-bucketing (LD and Quonfig hash
 * differently, so post-migration bucket assignments differ).
 */
export function rolloutToWeightedValues(rollout: SourceRollout, ctx: RulesetContext): QuonfigWeightedValues {
  if (rollout.kind === 'experiment') {
    ctx.report.add(
      'dropped-experiment-metadata',
      ctx.sourceKey,
      `experiment rollout converted to a plain weighted_values; experiment kind${
        rollout.seed === undefined ? '' : ` and seed ${rollout.seed}`
      } dropped`,
    )
  }

  const hashByPropertyName = rollout.bucketBy
    ? normalizeAttribute(rollout.contextKind, rollout.bucketBy)
    : `${rollout.contextKind && rollout.contextKind.length > 0 ? rollout.contextKind : 'user'}.key`

  ctx.report.add(
    'rebucketed-rollout',
    ctx.sourceKey,
    `percentage rollout hashed on "${hashByPropertyName}" — LaunchDarkly and Quonfig bucket differently, so users will be re-bucketed`,
  )

  // LD weights natively sum to 100000, but guard the predicate anyway
  // (qfg-wis6.11) — the hook now errors on non-conforming imports.
  let weights = rollout.variations.map((wv) => wv.weight)
  const normalized = normalizeImportedWeights(weights)
  if (normalized) {
    ctx.report.add('normalized-rollout-weights', ctx.sourceKey, normalized.detail)
    weights = normalized.weights
  }

  return {
    type: 'weighted_values',
    value: {
      hashByPropertyName,
      weightedValues: rollout.variations.map((wv, i) => ({
        value: variationValue(wv.variation, ctx),
        weight: weights[i],
      })),
    },
  }
}

/** Resolve a `variation`-or-`rollout` pointer (rule served value / fallthrough). */
export function servedValue(voR: SourceVariationOrRollout, ctx: RulesetContext): QuonfigRuleValue {
  if (voR.rollout) return rolloutToWeightedValues(voR.rollout, ctx)
  return variationValue(voR.variation ?? 0, ctx)
}

/**
 * Collapse a single LaunchDarkly per-environment flag state into an ordered,
 * first-match-wins Quonfig rule list.
 *
 *  - `on: false` → one ALWAYS_TRUE rule serving the `offVariation` value.
 *  - `on: true`  → individual/context targets become leading PROP_IS_ONE_OF
 *    rules; `rules[]` translate in order; `fallthrough` becomes a trailing
 *    ALWAYS_TRUE rule. Prerequisites are dropped + reported (no Quonfig
 *    cross-flag dependency operator in v1).
 */
export function collapseEnvironment(env: SourceFlagEnvironment, ctx: RulesetContext): QuonfigRule[] {
  if (!env.on) {
    return [{criteria: [ALWAYS_TRUE], value: variationValue(env.offVariation ?? 0, ctx)}]
  }

  const rules: QuonfigRule[] = []

  // Prerequisites are dropped (no cross-flag dependency operator in Quonfig v1)
  // but their reporting is owned by the caller (translateFlag), which dedupes
  // across environments and emits one enriched note per child flag (qfg-nb4n).
  // collapseEnvironment intentionally stays silent here.

  // Individual + context targets evaluate before rules in LaunchDarkly, so
  // they become leading rules. Lossy: the LD UI affordance is gone (plan §5.4).
  const allTargets: SourceTarget[] = [...(env.targets ?? []), ...(env.contextTargets ?? [])]
  for (const target of allTargets) {
    if (target.values.length === 0) continue
    const kind = target.contextKind && target.contextKind.length > 0 ? target.contextKind : 'user'
    rules.push({
      criteria: [
        {
          operator: 'PROP_IS_ONE_OF',
          propertyName: `${kind}.key`,
          valueToMatch: {type: 'string_list', value: [...target.values]},
        },
      ],
      value: variationValue(target.variation, ctx),
    })
    ctx.report.add(
      'individual-target-as-rule',
      ctx.sourceKey,
      `${target.values.length} ${kind} key(s) inlined into a leading PROP_IS_ONE_OF rule on ${kind}.key. ` +
        `**Trade-off:** you lost the LD 'targets' UI pane — adding/removing an individual now requires a ` +
        `config edit (qfg set / web UI), not a separate UI. If this was used for beta-list-style toggling, ` +
        `consider authoring a \`beta_user\` context attribute instead.`,
    )
  }

  for (const rule of env.rules ?? []) {
    const value =
      rule.rollout === undefined ? variationValue(rule.variation ?? 0, ctx) : rolloutToWeightedValues(rule.rollout, ctx)
    const built = buildRule(rule.clauses, value, ctx)
    if (built !== null) rules.push(built)
  }

  if (env.fallthrough) {
    rules.push({criteria: [ALWAYS_TRUE], value: servedValue(env.fallthrough, ctx)})
  }

  return rules
}
