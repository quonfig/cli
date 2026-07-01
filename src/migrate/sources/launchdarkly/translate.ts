/**
 * LaunchDarkly converter — LaunchDarkly flag/segment JSON → `QuonfigFile[]`.
 *
 * This is the provider-specific topology collapse (plan §3.1, Epic 3). It calls
 * the shared `quonfig-target/` verb library for the parts that are not
 * LaunchDarkly-specific (operator mapping, value coercion, ordered-ruleset
 * collapse) and handles the LaunchDarkly-shaped structure here: variations →
 * variants, per-environment state → `environments[]`, the gap dispositions of
 * plan §5.4.
 */

import {resolveKey} from '../../key-rewriter.js'
import {ConversionReport} from '../../quonfig-target/report.js'
import {
  clauseToCriterion,
  collapseEnvironment,
  type QuonfigCriterion,
  type QuonfigRule,
  type RulesetContext,
} from '../../quonfig-target/ruleset.js'
import {inferFlagValueType, type QuonfigValue, toQuonfigValue} from '../../quonfig-target/values.js'
import type {LDClause, LDFlag, LDSegment} from './types.js'

const ALWAYS_TRUE = {operator: 'ALWAYS_TRUE' as const}

/**
 * qfg-6na9.3: resolve keys through the per-run key rewriter for Policy A
 * conformance. LD keys are already `[A-Za-z0-9._-]`, so this is a strict no-op
 * in practice — wired for uniformity + future-proofing (an odd imported key
 * would still be made safe, and stay in sync with any IN_SEG reference to it,
 * which resolves through `ruleset.ts`).
 */
function normalizeKey(key: string): string {
  return resolveKey(key)
}

/** Environment keys are LD slugs already; lowercase + hyphenate to be safe. */
function slugifyEnvKey(key: string): string {
  return key
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

/**
 * Gather every prerequisite edge declared across all of a flag's environments
 * and dedupe by parent key — the orphan-parent view is per-flag, not
 * per-environment. First occurrence wins for the variation index when an
 * unusual config gates on the same parent at different variations in different
 * envs (rare; the typical case is identical edges in every env).
 */
function collectPrerequisiteEdges(flag: LDFlag): Array<{parentKey: string; variation: number}> {
  const seen = new Set<string>()
  const edges: Array<{parentKey: string; variation: number}> = []
  for (const envState of Object.values(flag.environments)) {
    for (const prereq of envState.prerequisites ?? []) {
      if (seen.has(prereq.key)) continue
      seen.add(prereq.key)
      edges.push({parentKey: prereq.key, variation: prereq.variation})
    }
  }

  return edges
}

export function flagOutputPath(key: string): string {
  return `feature-flags/${normalizeKey(key)}.json`
}

export function segmentOutputPath(key: string): string {
  return `segments/${normalizeKey(key)}.json`
}

/**
 * Translate one LaunchDarkly flag into a Quonfig feature-flag file.
 *
 * Structure:
 *  - `variations[]` → typed `variants[]`
 *  - per-environment state → `environments[]` (each collapsed via the verb lib)
 *  - `default.rules` → a baseline ALWAYS_TRUE rule serving variation 0; any
 *    environment LaunchDarkly did not define falls back to this.
 *
 * Gap dispositions (plan §5.4) are recorded on `report` — nothing silent.
 */
export function translateFlag(flag: LDFlag, report: ConversionReport): Record<string, unknown> {
  const variationValues = flag.variations.map((v) => v.value)
  const valueType = inferFlagValueType(flag.kind, variationValues)

  const ctx: RulesetContext = {
    report,
    sourceKey: flag.key,
    valueType,
    variationValues,
  }

  // clientSideAvailability: feature flags are always client-visible in Quonfig,
  // so `sendToClientSdk` is invalid on them — we cannot carry the dimension.
  // Split the drop by usingEnvironmentId co-state (qfg-iv69):
  //  - usingEnvironmentId:true  → flag is still client-visible, pure rollup noise.
  //  - usingEnvironmentId:false → flag was mobile-only, now server-only post-migration (must-fix).
  if (flag.clientSideAvailability?.usingMobileKey) {
    if (flag.clientSideAvailability.usingEnvironmentId) {
      report.add(
        'dropped-mobile-key-still-visible',
        flag.key,
        `clientSideAvailability.usingMobileKey was true; usingEnvironmentId was also true — flag remains client-visible via Quonfig's sendToClientSdk, the mobile-key dimension itself is dropped`,
      )
    } else {
      report.add(
        'dropped-mobile-key-now-server-only',
        flag.key,
        `clientSideAvailability.usingMobileKey was true but usingEnvironmentId was false — flag was mobile-only in LaunchDarkly and will not reach mobile clients post-migration; rebuild client-side access by hand before cutover`,
      )
    }
  }

  if (flag.maintainerId || flag.maintainerTeamKey) {
    report.add(
      'dropped-maintainer',
      flag.key,
      `maintainer ${flag.maintainerId ?? flag.maintainerTeamKey} dropped — Quonfig authorship lives in git history`,
    )
  }

  if (flag.customProperties && Object.keys(flag.customProperties).length > 0) {
    report.add(
      'dropped-custom-properties',
      flag.key,
      `customProperties (${Object.keys(flag.customProperties).join(', ')}) dropped — report-only in v1 (D6)`,
    )
  }

  // Prerequisites — dedupe across environments by parent key so a flag gated on
  // the same parent in N environments emits one note, not N (qfg-nb4n). The
  // detail spells out every parent's variation index plus a one-line remediation
  // so a human knows exactly how to restore the gate; the structured
  // `prerequisites` payload feeds the inverted orphan-parent view in the report.
  const prereqEdges = collectPrerequisiteEdges(flag)
  if (prereqEdges.length > 0) {
    const parentList = prereqEdges.map((e) => `\`${e.parentKey}\` = variation ${e.variation}`).join(', ')
    const detail =
      `evaluated independently of ${prereqEdges.length} parent${prereqEdges.length === 1 ? '' : 's'} ` +
      `(${parentList}). To preserve the gate, add a leading rule matching the same parent state, ` +
      `or wrap reads in app code — Quonfig v1 has no cross-flag dependency operator.`
    report.add('dropped-prerequisite', flag.key, detail, {prerequisites: prereqEdges})
  }

  const variants = flag.variations.map((v) => {
    const variant: {description?: string; name?: string; value: QuonfigValue} = {
      value: toQuonfigValue(v.value, valueType),
    }
    if (v.name !== undefined) variant.name = v.name
    if (v.description !== undefined) variant.description = v.description
    return variant
  })

  const environments = Object.entries(flag.environments)
    .map(([envKey, envState]) => ({
      id: slugifyEnvKey(envKey),
      rules: collapseEnvironment(envState, ctx),
    }))
    // Stable output order regardless of JSON key iteration order.
    .sort((a, b) => a.id.localeCompare(b.id))

  // Baseline default: any environment LaunchDarkly did not define serves
  // variation 0. LaunchDarkly state is entirely per-environment, so there is
  // no source-side "default" — this is a documented, conservative choice.
  const out: Record<string, unknown> = {
    key: normalizeKey(flag.key),
    type: 'feature_flag',
    valueType,
    default: {
      rules: [{criteria: [ALWAYS_TRUE], value: toQuonfigValue(variationValues[0], valueType)}],
    },
    environments,
    variants,
  }

  if (flag.name !== undefined) out.name = flag.name
  if (flag.description !== undefined) out.description = flag.description
  if (flag.tags && flag.tags.length > 0) out.tags = [...flag.tags]

  return out
}

/**
 * Translate one LaunchDarkly segment into a Quonfig segment file.
 *
 * Quonfig segments are boolean ("is the context in the segment?") and have no
 * per-environment state, so everything collapses into `default.rules`,
 * first-match-wins, matching LaunchDarkly's evaluation precedence:
 * excluded → included → rules → (not in segment).
 *
 * Big/synced segments (`unbounded: true`) cannot have their membership
 * exported via the REST API — the shell + rules are emitted and the loss is
 * reported (plan §5.4).
 */
export function translateSegment(segment: LDSegment, report: ConversionReport): Record<string, unknown> {
  const ctx: RulesetContext = {
    report,
    sourceKey: segment.key,
    valueType: 'bool',
    variationValues: [],
  }

  const rules: QuonfigRule[] = []

  if (segment.unbounded) {
    report.add(
      'unexportable-segment-membership',
      segment.key,
      `big/synced segment (unbounded) — membership is not exportable via the LaunchDarkly REST API; only the rule shell is imported`,
    )
  }

  const keyListRule = (kind: string, values: string[], inSegment: boolean): QuonfigRule => ({
    criteria: [
      {
        operator: 'PROP_IS_ONE_OF',
        propertyName: `${kind}.key`,
        valueToMatch: {type: 'string_list', value: [...values]},
      },
    ],
    value: {type: 'bool', value: inSegment},
  })

  // Excluded contexts win over included — match LaunchDarkly precedence.
  if (segment.excluded && segment.excluded.length > 0) rules.push(keyListRule('user', segment.excluded, false))
  for (const ec of segment.excludedContexts ?? []) {
    if (ec.values.length > 0) rules.push(keyListRule(ec.contextKind, ec.values, false))
  }

  if (segment.included && segment.included.length > 0) rules.push(keyListRule('user', segment.included, true))
  for (const ic of segment.includedContexts ?? []) {
    if (ic.values.length > 0) rules.push(keyListRule(ic.contextKind, ic.values, true))
  }

  for (const rule of segment.rules ?? []) {
    const built = buildSegmentRule(rule, ctx)
    if (built !== null) rules.push(built)
  }

  // Trailing catch-all: anyone not matched above is not in the segment.
  rules.push({criteria: [ALWAYS_TRUE], value: {type: 'bool', value: false}})

  const out: Record<string, unknown> = {
    key: normalizeKey(segment.key),
    type: 'segment',
    valueType: 'bool',
    default: {rules},
    environments: [],
    variants: [],
  }

  if (segment.name !== undefined) out.name = segment.name
  if (segment.description !== undefined) out.description = segment.description
  if (segment.tags && segment.tags.length > 0) out.tags = [...segment.tags]

  return out
}

/**
 * Build a Quonfig rule from a LaunchDarkly segment rule. A segment rule's
 * clauses AND together and the rule means "in the segment". A rule-level
 * `weight` is a percentage of matching contexts — converted to a
 * `weighted_values` bool split (and reported as re-bucketing). Returns `null`
 * when a clause cannot be mapped (the whole rule is dropped — see `buildRule`).
 */
function buildSegmentRule(
  rule: {bucketBy?: string; clauses: LDClause[]; weight?: number},
  ctx: RulesetContext,
): QuonfigRule | null {
  // Reuse the clause-mapping verb via a tiny inline AND loop so segment rules
  // get the exact same operator handling (and whole-rule-drop) as flag rules.
  const criteria: QuonfigCriterion[] = []
  for (const clause of rule.clauses) {
    const criterion = clauseToCriterion(clause, ctx)
    if (criterion === null) return null
    criteria.push(criterion)
  }

  const value =
    rule.weight === undefined
      ? {type: 'bool' as const, value: true}
      : {
          type: 'weighted_values' as const,
          value: {
            hashByPropertyName: rule.bucketBy
              ? `user.${rule.bucketBy.replace(/^\//, '').replaceAll('/', '.')}`
              : 'user.key',
            weightedValues: [
              {value: {type: 'bool' as const, value: true}, weight: rule.weight},
              {value: {type: 'bool' as const, value: false}, weight: Math.max(0, 100_000 - rule.weight)},
            ],
          },
        }

  if (rule.weight !== undefined) {
    ctx.report.add(
      'rebucketed-rollout',
      ctx.sourceKey,
      `segment rule has a ${rule.weight / 1000}% weight — converted to a weighted bool split; users will be re-bucketed`,
    )
  }

  return {criteria: criteria.length > 0 ? criteria : [ALWAYS_TRUE], value}
}
