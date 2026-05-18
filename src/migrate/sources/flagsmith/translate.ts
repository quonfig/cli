/**
 * Flagsmith converter — Flagsmith feature/segment JSON → `QuonfigFile`-ready
 * objects (plain JS objects ready for `JSON.stringify`).
 *
 * Provider-specific topology collapse (plan §5, Epic 3). Calls the shared
 * `quonfig-target/` verb library where the structure is identical to LD
 * (value coercion, criterion + rule shape, report wiring) and handles the
 * Flagsmith-shaped bits here: synthesizing the ordered rule list from
 * `feature_state` + `segment_overrides` + `identity_overrides` (§5.1),
 * `enabled=false` disposition per D-F1, operator mapping with `:semver`
 * suffix detection (§5.3), multivariate weighted-values shape (§5.4),
 * cross-env value-type coercion per D-F5.
 *
 * This module is a pure function — no I/O, no env reads, no module-level
 * mutable state. Report accumulation flows through the `ConversionReport`
 * argument supplied by the caller (the `flagsmith.ts` source).
 */

import type {ConversionReport} from '../../quonfig-target/report.js'
import type {QuonfigOperator} from '../../quonfig-target/operators.js'
import type {QuonfigCriterion, QuonfigRule, QuonfigRuleValue} from '../../quonfig-target/ruleset.js'
import {type QuonfigValue, type QuonfigValueType, inferValueType, toQuonfigValue} from '../../quonfig-target/values.js'
import type {
  FlagsmithEdgeIdentityOverride,
  FlagsmithFeature,
  FlagsmithFeatureState,
  FlagsmithFeatureStateValueEnvelope,
  FlagsmithFeatureWithStates,
  FlagsmithMultivariateFeatureStateValue,
  FlagsmithMultivariateOption,
  FlagsmithSegment,
  FlagsmithSegmentCondition,
  FlagsmithSegmentRule,
  FlagsmithTag,
} from './types.js'

const ALWAYS_TRUE: QuonfigCriterion = {operator: 'ALWAYS_TRUE'}

/** Flagsmith identity-override rule keys context attributes under this propertyName. */
const IDENTITY_PROPERTY_NAME = 'user.key'

/** Suffix Flagsmith uses to switch a comparison operator from string to semver. */
const SEMVER_SUFFIX = ':semver'

/**
 * Operator-mapping result. A clean criterion translation OR a whole-rule drop
 * with a precise reason. Returned per condition; the rule is dropped if any
 * condition drops.
 */
type ConditionMapping = {criterion: QuonfigCriterion} | {drop: true; reason: string}

/** Per-feature translate context — value type, variant pool, report sink. */
interface FeatureContext {
  feature: FlagsmithFeature
  report: ConversionReport
  /** Indexed map from segment id → segment name, so segment-override IN_SEG criteria carry the readable key. */
  segmentNameById: Map<number, string>
  /** Map from tag id → label so the converter can resolve `feature.tags[]` to readable strings. */
  tagLabelById: Map<number, string>
  valueType: QuonfigValueType
}

/**
 * Flagsmith feature names land directly under `feature-flags/` — Flagsmith
 * enforces a lower-case-hyphenated naming policy on most projects, so the
 * key is already filesystem-safe. We still defensively replace any `/` so
 * a name can never spawn a nested directory.
 */
export function flagOutputPath(name: string): string {
  return `feature-flags/${normalizeKey(name)}.json`
}

export function segmentOutputPath(name: string): string {
  return `segments/${normalizeKey(name)}.json`
}

function normalizeKey(key: string): string {
  return key.replaceAll('/', '.')
}

/** Env name → Quonfig env id slug (matches the source-module slugifier). */
function slugifyEnvName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

/**
 * Unwrap the `feature_state_value` field as it appears on the
 * `/features/featurestates/` endpoint (envelope shape on env-default and
 * segment-override rows; scalar on `/edge-identity-overrides` per API5).
 * Returns the raw JS value Flagsmith would have served before any Quonfig
 * type coercion.
 */
export function coerceEnvelopeOrScalar(
  v: FlagsmithFeatureStateValueEnvelope | boolean | null | number | string | undefined,
): boolean | null | number | string {
  if (v === undefined) return null
  if (v === null) return null
  if (typeof v === 'object') {
    if (v.type === 'bool') return v.boolean_value ?? false
    if (v.type === 'int') return v.integer_value ?? 0
    // 'unicode' (and any unknown envelope type) defaults to the string slot.
    return v.string_value ?? ''
  }

  return v
}

/**
 * Resolve a multivariate option's typed value to the raw JS value Flagsmith
 * would have served. The option's discriminator is `type: 'unicode' | 'int' | 'bool'`.
 */
function mvOptionValue(opt: FlagsmithMultivariateOption): boolean | null | number | string {
  if (opt.type === 'bool') return opt.boolean_value ?? false
  if (opt.type === 'int') return opt.integer_value ?? 0
  return opt.string_value ?? ''
}

/**
 * Decide the feature's Quonfig valueType. Multivariate features take their
 * type from the variation values (all variants share a type in valid Flagsmith
 * data); STANDARD features look at the env-default `feature_state_value` shape
 * across every env. D-F5: if envs diverge, coerce to `string` and emit a loud
 * report entry per diverged feature.
 */
function decideValueType(bundle: FlagsmithFeatureWithStates, report: ConversionReport): QuonfigValueType {
  const {feature, featurestates_by_env} = bundle
  const mvOptions = feature.multivariate_options ?? []

  if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
    const variantValues = mvOptions.map((o) => mvOptionValue(o))
    const types = new Set(variantValues.map((v) => inferValueType(v)))
    if (types.size === 1) {
      const only = [...types][0]
      if (only === 'string' || only === 'int' || only === 'bool' || only === 'double') return only
    }

    // Mixed-type multivariates are vanishingly rare in Flagsmith; fall back to
    // string so every variant serializes uniformly.
    return 'string'
  }

  // STANDARD: scan every env-default row's value type. Identity/segment
  // overrides can ALSO have divergent types in pathological data — we still
  // only coerce when env-defaults disagree, since that's the visible case in
  // §5.5 / D-F5; overrides on a mismatched feature lose precision the same way.
  const envTypes = new Map<string, QuonfigValueType>()
  for (const [envApiKey, bundleForEnv] of Object.entries(featurestates_by_env)) {
    if (bundleForEnv.default) {
      const raw = coerceEnvelopeOrScalar(bundleForEnv.default.feature_state_value)
      envTypes.set(envApiKey, inferValueType(raw))
    }
  }

  const distinct = new Set(envTypes.values())
  if (distinct.size <= 1) {
    const only = [...distinct][0]
    if (only === undefined) return 'string'
    if (only === 'string' || only === 'int' || only === 'bool' || only === 'double') return only
    // 'json' (null/object/array) is rare for Flagsmith primitives — leave as string.
    return 'string'
  }

  // D-F5: multiple envs disagree on type — coerce to string and report.
  const detail = `feature_state_value type diverges across environments (${[...envTypes.entries()]
    .map(([env, t]) => `${env}=${t}`)
    .join(', ')}) — Quonfig requires one valueType per flag, coerced to string`
  report.add('cross-env-value-type-coerced', feature.name, detail)
  return 'string'
}

/**
 * Map one Flagsmith condition to a Quonfig criterion, or signal a whole-rule
 * drop with a reason. Implements plan §5.3 verbatim.
 */
export function mapCondition(condition: FlagsmithSegmentCondition): ConditionMapping {
  const {operator, property, value} = condition
  const propertyName = property && property.length > 0 ? property : 'user.key'

  const hasSemver = typeof value === 'string' && value.endsWith(SEMVER_SUFFIX)
  const semverValue = hasSemver ? (value as string).slice(0, -SEMVER_SUFFIX.length) : null

  switch (operator) {
    case 'EQUAL': {
      if (hasSemver) {
        return {
          criterion: {
            operator: 'PROP_SEMVER_EQUAL',
            propertyName,
            valueToMatch: {type: 'string', value: semverValue ?? ''},
          },
        }
      }

      return {
        criterion: {
          operator: 'PROP_IS_ONE_OF',
          propertyName,
          valueToMatch: {type: 'string_list', value: [String(value ?? '')]},
        },
      }
    }

    case 'NOT_EQUAL': {
      if (hasSemver) {
        return {
          drop: true,
          reason: 'NOT_EQUAL with :semver suffix has no Quonfig equivalent (no PROP_SEMVER_NOT_EQUAL)',
        }
      }

      return {
        criterion: {
          operator: 'PROP_IS_NOT_ONE_OF',
          propertyName,
          valueToMatch: {type: 'string_list', value: [String(value ?? '')]},
        },
      }
    }

    case 'GREATER_THAN': {
      if (hasSemver) {
        return {
          criterion: {
            operator: 'PROP_SEMVER_GREATER_THAN',
            propertyName,
            valueToMatch: {type: 'string', value: semverValue ?? ''},
          },
        }
      }

      return {
        criterion: makeNumericCriterion('PROP_GREATER_THAN', propertyName, value),
      }
    }

    case 'GREATER_THAN_INCLUSIVE': {
      if (hasSemver) {
        return {
          drop: true,
          reason:
            'GREATER_THAN_INCLUSIVE with :semver suffix has no Quonfig equivalent (no PROP_SEMVER_GREATER_THAN_OR_EQUAL)',
        }
      }

      return {
        criterion: makeNumericCriterion('PROP_GREATER_THAN_OR_EQUAL', propertyName, value),
      }
    }

    case 'LESS_THAN': {
      if (hasSemver) {
        return {
          criterion: {
            operator: 'PROP_SEMVER_LESS_THAN',
            propertyName,
            valueToMatch: {type: 'string', value: semverValue ?? ''},
          },
        }
      }

      return {
        criterion: makeNumericCriterion('PROP_LESS_THAN', propertyName, value),
      }
    }

    case 'LESS_THAN_INCLUSIVE': {
      if (hasSemver) {
        return {
          drop: true,
          reason:
            'LESS_THAN_INCLUSIVE with :semver suffix has no Quonfig equivalent (no PROP_SEMVER_LESS_THAN_OR_EQUAL)',
        }
      }

      return {
        criterion: makeNumericCriterion('PROP_LESS_THAN_OR_EQUAL', propertyName, value),
      }
    }

    case 'CONTAINS': {
      return {
        criterion: {
          operator: 'PROP_CONTAINS_ONE_OF',
          propertyName,
          valueToMatch: {type: 'string_list', value: [String(value ?? '')]},
        },
      }
    }

    case 'NOT_CONTAINS': {
      return {
        criterion: {
          operator: 'PROP_DOES_NOT_CONTAIN_ONE_OF',
          propertyName,
          valueToMatch: {type: 'string_list', value: [String(value ?? '')]},
        },
      }
    }

    case 'REGEX': {
      return {
        criterion: {
          operator: 'PROP_MATCHES',
          propertyName,
          valueToMatch: {type: 'string', value: String(value ?? '')},
        },
      }
    }

    case 'IS_SET': {
      return {criterion: {operator: 'IS_PRESENT', propertyName}}
    }

    case 'IS_NOT_SET': {
      return {criterion: {operator: 'IS_NOT_PRESENT', propertyName}}
    }

    case 'IN': {
      // Flagsmith ships IN values as comma-separated strings, NOT JSON arrays.
      const parts =
        typeof value === 'string'
          ? value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : []
      return {
        criterion: {
          operator: 'PROP_IS_ONE_OF',
          propertyName,
          valueToMatch: {type: 'string_list', value: parts.length > 0 ? parts : [String(value ?? '')]},
        },
      }
    }

    case 'MODULO': {
      return {drop: true, reason: 'Flagsmith MODULO operator has no Quonfig equivalent'}
    }

    case 'PERCENTAGE_SPLIT': {
      return {
        drop: true,
        reason:
          'Flagsmith PERCENTAGE_SPLIT inside a segment condition has no Quonfig equivalent (rule-level weighted_values only)',
      }
    }

    default: {
      return {drop: true, reason: `unrecognized Flagsmith operator "${operator}"`}
    }
  }
}

function makeNumericCriterion(
  operator: Extract<
    QuonfigOperator,
    'PROP_GREATER_THAN' | 'PROP_GREATER_THAN_OR_EQUAL' | 'PROP_LESS_THAN' | 'PROP_LESS_THAN_OR_EQUAL'
  >,
  propertyName: string,
  rawValue: null | string | undefined,
): QuonfigCriterion {
  const num = rawValue === null || rawValue === undefined || rawValue === '' ? 0 : Number(rawValue)
  if (Number.isFinite(num)) {
    return {
      operator,
      propertyName,
      valueToMatch: {type: Number.isInteger(num) ? 'int' : 'double', value: num},
    }
  }

  // Non-numeric value on a numeric operator — emit a string fallback. Flagsmith
  // coerces at runtime so this is rare; keeping the operator preserves intent.
  return {operator, propertyName, valueToMatch: {type: 'string', value: String(rawValue ?? '')}}
}

/**
 * Convert a Flagsmith segment rule subtree (possibly nested with type=ALL/ANY/NONE)
 * into a flat list of Quonfig criteria. Quonfig has no within-rule OR, so:
 *  - ALL (AND) is honored: each child contributes its criteria, ANDed.
 *  - ANY (OR) on a sibling rule list is a structural mismatch — we drop the
 *    rule with a precise reason rather than silently AND it.
 *  - NONE (NOT-ANY) — same: drop with reason.
 *
 * Returns null when the subtree cannot be flattened (some child dropped).
 */
function flattenSegmentRuleForSegment(
  rule: FlagsmithSegmentRule,
  segment: FlagsmithSegment,
  report: ConversionReport,
): null | QuonfigCriterion[] {
  if (rule.type !== 'ALL') {
    report.add(
      'skipped-rule',
      segment.name,
      `Flagsmith segment rule with type=${rule.type} cannot be expressed in Quonfig (no within-rule OR); whole rule dropped`,
    )
    return null
  }

  const criteria: QuonfigCriterion[] = []
  for (const cond of rule.conditions) {
    const mapped = mapCondition(cond)
    if ('drop' in mapped) {
      report.add(
        'skipped-rule',
        segment.name,
        `condition on "${cond.property ?? ''}" (${cond.operator}) dropped: ${mapped.reason}`,
      )
      return null
    }

    criteria.push(mapped.criterion)
  }

  for (const child of rule.rules ?? []) {
    const sub = flattenSegmentRuleForSegment(child, segment, report)
    if (sub === null) return null
    criteria.push(...sub)
  }

  return criteria
}

/**
 * Convert an env-default featurestate's served value into a Quonfig RuleValue.
 *
 * MULTIVARIATE features serve a weighted_values rollout (using per-env override
 * weights when present, else project-level defaults). Identity-override rules
 * on MV features handle pinning separately (see `identityOverrideRuleValue`).
 */
function envDefaultRuleValue(
  bundle: FlagsmithFeatureWithStates,
  envApiKey: string,
  fsState: FlagsmithFeatureState | null,
  ctx: FeatureContext,
): QuonfigRuleValue {
  const {feature} = bundle
  const mvOptions = feature.multivariate_options ?? []

  // enabled=false (D-F1)
  if (fsState && !fsState.enabled) {
    if (ctx.valueType === 'bool') {
      return {type: 'bool', value: false}
    }

    if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
      const detail = `non-boolean MULTIVARIATE feature is disabled in env "${envApiKey}" — Flagsmith would have served your code's default; Quonfig now serves the stored weighted_values`
      ctx.report.add('enabled-false-non-boolean', feature.name, detail)
    } else {
      const stored = coerceEnvelopeOrScalar(fsState.feature_state_value)
      const detail = `non-boolean feature is disabled in env "${envApiKey}" — Flagsmith would have served your code's default; Quonfig now serves ${JSON.stringify(
        stored,
      )}`
      ctx.report.add('enabled-false-non-boolean', feature.name, detail)
    }
    // Fall through to served-value emission below so we still produce a value.
  }

  if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
    return multivariateWeightedValue(mvOptions, fsState?.multivariate_feature_state_values ?? [], ctx)
  }

  if (!fsState) {
    // No default featurestate for this env (rare — partial-fetch error). Serve
    // the value-type's zero-ish typed value so downstream validation accepts it.
    return zeroValueFor(ctx.valueType)
  }

  const raw = coerceEnvelopeOrScalar(fsState.feature_state_value)
  return toQuonfigValue(raw, ctx.valueType)
}

/** Identity-override rule value: pinned single variation OR re-weighted MV allocation (D-F7). */
function identityOverrideRuleValue(
  bundle: FlagsmithFeatureWithStates,
  override: FlagsmithEdgeIdentityOverride,
  ctx: FeatureContext,
): QuonfigRuleValue {
  const {feature} = bundle
  const mvOptions = feature.multivariate_options ?? []
  const mvWeights = override.feature_state.multivariate_feature_state_values ?? []

  // enabled=false on the override: prefer the served value of the override's
  // own feature_state_value, with the same D-F1 reporting if non-boolean.
  if (!override.feature_state.enabled) {
    if (ctx.valueType === 'bool') {
      return {type: 'bool', value: false}
    }

    if (feature.type !== 'MULTIVARIATE') {
      ctx.report.add(
        'enabled-false-non-boolean',
        feature.name,
        `identity override "${override.identifier}" is disabled — Flagsmith would have served your code's default; Quonfig now serves the stored value`,
      )
    }
  }

  // MV with re-weighted allocation (D-F7): per-identity weight vector wins.
  if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0 && mvWeights.length > 0) {
    return multivariateWeightedValue(mvOptions, mvWeights, ctx)
  }

  // MV pinned to a single variation — also expressed via the SDK as a scalar
  // `feature_state_value` matching one of the variant values. Emit as the
  // typed scalar; Quonfig serves that variant.
  const raw = coerceEnvelopeOrScalar(override.feature_state.feature_state_value)
  return toQuonfigValue(raw, ctx.valueType)
}

/**
 * Like `envDefaultRuleValue` but never emits report entries — used by the
 * baseline `default.rules` so the D-F1 / D-F5 sentinels are only counted once
 * (during the per-env walk).
 */
function servedValueSilent(
  bundle: FlagsmithFeatureWithStates,
  fsState: FlagsmithFeatureState | null,
  ctx: FeatureContext,
): QuonfigRuleValue {
  const {feature} = bundle
  const mvOptions = feature.multivariate_options ?? []

  if (fsState && !fsState.enabled && ctx.valueType === 'bool') {
    return {type: 'bool', value: false}
  }

  if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
    return multivariateWeightedValue(mvOptions, fsState?.multivariate_feature_state_values ?? [], ctx)
  }

  if (!fsState) return zeroValueFor(ctx.valueType)
  const raw = coerceEnvelopeOrScalar(fsState.feature_state_value)
  return toQuonfigValue(raw, ctx.valueType)
}

/** Build a Quonfig `weighted_values` rule value from a list of MV options + (optional) per-env weights. */
function multivariateWeightedValue(
  mvOptions: FlagsmithMultivariateOption[],
  perEnvWeights: FlagsmithMultivariateFeatureStateValue[],
  ctx: FeatureContext,
): QuonfigRuleValue {
  // Index per-env weights by MV option id for fast lookup.
  const weightByOption = new Map<number, number>()
  for (const w of perEnvWeights) weightByOption.set(w.multivariate_feature_option, w.percentage_allocation)

  // Flagsmith weights are percentages 0–100; Quonfig uses 0–100_000 (1000 units = 1%).
  const weightedValues = mvOptions.map((opt) => {
    const pct = weightByOption.get(opt.id) ?? opt.default_percentage_allocation
    return {
      value: toQuonfigValue(mvOptionValue(opt), ctx.valueType),
      weight: Math.round(pct * 1000),
    }
  })

  return {
    type: 'weighted_values',
    value: {
      hashByPropertyName: 'user.key',
      weightedValues,
    },
  }
}

function zeroValueFor(valueType: QuonfigValueType): QuonfigValue {
  switch (valueType) {
    case 'bool': {
      return {type: 'bool', value: false}
    }

    case 'double': {
      return {type: 'double', value: 0}
    }

    case 'int': {
      return {type: 'int', value: 0}
    }

    case 'json': {
      return {type: 'json', value: null}
    }

    case 'string_list': {
      return {type: 'string_list', value: []}
    }

    default: {
      return {type: 'string', value: ''}
    }
  }
}

/**
 * Build the variants[] array for a Quonfig feature flag. MULTIVARIATE features
 * surface each Flagsmith option as a variant; STANDARD bool features get the
 * implicit `true`/`false` variants Quonfig already understands; STANDARD
 * value-typed features have an empty variants[] (Quonfig allows that for
 * non-rollout flags).
 */
function buildVariants(feature: FlagsmithFeature, valueType: QuonfigValueType): Array<Record<string, unknown>> {
  const mvOptions = feature.multivariate_options ?? []
  if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
    return mvOptions.map((opt) => {
      const raw = mvOptionValue(opt)
      const variant: Record<string, unknown> = {value: toQuonfigValue(raw, valueType)}
      // Flagsmith doesn't give MV options a name — use the stringified value
      // for human-readability in the Quonfig UI.
      variant.name = String(raw)
      return variant
    })
  }

  if (valueType === 'bool') {
    return [
      {name: 'true', value: {type: 'bool', value: true}},
      {name: 'false', value: {type: 'bool', value: false}},
    ]
  }

  return []
}

/**
 * Translate one Flagsmith feature (with all its per-env state) into a Quonfig
 * feature-flag config object.
 */
export function translateFeature(
  bundle: FlagsmithFeatureWithStates,
  report: ConversionReport,
  options: {
    /** Map from env api_key → user-facing env name. The converter slugifies the name for the Quonfig env id. */
    envNameByApiKey?: Map<string, string>
    segmentNameById?: Map<number, string>
    tags?: FlagsmithTag[]
  } = {},
): Record<string, unknown> {
  const {feature, featurestates_by_env, feature_segments_by_env} = bundle
  const valueType = decideValueType(bundle, report)
  const tagLabelById = new Map<number, string>()
  for (const t of options.tags ?? []) tagLabelById.set(t.id, t.label)
  const segmentNameById = options.segmentNameById ?? new Map<number, string>()

  // Per-env lookup: FeatureSegment.id -> Segment.id. The featurestates endpoint
  // returns `feature_segment` as the join-table id (a number), not the
  // underlying segment id; resolve via `feature_segments_by_env` which the
  // fetcher already populated per (env, feature).
  const segmentIdByFeatureSegmentId: Record<string, Map<number, number>> = {}
  for (const [envApiKey, fseg] of Object.entries(feature_segments_by_env ?? {})) {
    const m = new Map<number, number>()
    for (const fs of fseg) m.set(fs.id, fs.segment)
    segmentIdByFeatureSegmentId[envApiKey] = m
  }

  const ctx: FeatureContext = {feature, report, segmentNameById, tagLabelById, valueType}

  // Per-env rule list synthesis (plan §5.1, D-F2 ordering): identity overrides
  // first, then segment overrides (already sorted ASC by priority by the
  // fetcher), then the trailing ALWAYS_TRUE serving the env default.
  const environments = Object.entries(featurestates_by_env)
    .map(([envApiKey, envBundle]) => {
      const rules: QuonfigRule[] = []

      // 1. Identity-override rules (D-F2 first).
      for (const idov of envBundle.identity_overrides) {
        const value = identityOverrideRuleValue(bundle, idov, ctx)
        rules.push({
          criteria: [
            {
              operator: 'PROP_IS_ONE_OF',
              propertyName: IDENTITY_PROPERTY_NAME,
              valueToMatch: {type: 'string_list', value: [idov.identifier]},
            },
          ],
          value,
        })
        ctx.report.add(
          'identity-override-as-rule',
          feature.name,
          `identity "${idov.identifier}" in env "${envApiKey}" inlined as a leading PROP_IS_ONE_OF rule on ${IDENTITY_PROPERTY_NAME}. ` +
            `Quonfig v1 has no individual-target primitive — adding/removing identities now requires a config edit, not a separate UI.`,
        )
      }

      // 2. Segment-override rules (D-F2 second; fetcher pre-sorted by priority ASC).
      for (const segov of envBundle.segment_overrides) {
        const fsegRef = segov.feature_segment
        const segmentId =
          typeof fsegRef === 'object' && fsegRef !== null
            ? fsegRef.segment
            : typeof fsegRef === 'number'
              ? (segmentIdByFeatureSegmentId[envApiKey]?.get(fsegRef) ?? null)
              : null
        const segmentName = segmentId === null ? undefined : segmentNameById.get(segmentId)
        if (!segmentName) {
          // Unresolvable segment reference — drop with report so it can't go silent.
          ctx.report.add(
            'skipped-rule',
            feature.name,
            `segment-override row in env "${envApiKey}" references segment id ${
              segmentId ?? '(unknown)'
            } which is not in the project segment pool — rule dropped`,
          )
          continue
        }

        // Per D-F4: a segment whose rules include PERCENTAGE_SPLIT or MODULO
        // would already be a structural mismatch. The drop happens inside the
        // segment-file translation; here we still emit the IN_SEG override
        // because the segment file exists. The segment-file rules may have
        // been emptied (just the trailing catch-all left) — that's the user's
        // signal that the override never matches anyone.
        rules.push(buildSegmentOverrideRule(segov, segmentName, bundle, ctx))
      }

      // 3. Trailing ALWAYS_TRUE rule serving the env default.
      rules.push({
        criteria: [ALWAYS_TRUE],
        value: envDefaultRuleValue(bundle, envApiKey, envBundle.default, ctx),
      })

      const readableName = options.envNameByApiKey?.get(envApiKey) ?? envApiKey
      return {id: slugifyEnvName(readableName), rules}
    })
    // Stable output order.
    .sort((a, b) => a.id.localeCompare(b.id))

  // Baseline `default` rules: serve the first env's default value (or the
  // value-type's zero) so any env Flagsmith didn't define has a defined
  // fallback. Mirrors LD's choice in `translateFlag`. Use the silent helper
  // so we don't double-emit the D-F1 / D-F5 sentinel notes — those were
  // already accumulated by the per-env walk above.
  const firstEnvApiKey = Object.keys(featurestates_by_env)[0]
  const firstEnvBundle = firstEnvApiKey ? featurestates_by_env[firstEnvApiKey] : undefined
  const defaultRules: QuonfigRule[] = [
    {
      criteria: [ALWAYS_TRUE],
      value: firstEnvBundle ? servedValueSilent(bundle, firstEnvBundle.default, ctx) : zeroValueFor(valueType),
    },
  ]

  const out: Record<string, unknown> = {
    key: normalizeKey(feature.name),
    type: 'feature_flag',
    valueType,
    default: {rules: defaultRules},
    environments,
    variants: buildVariants(feature, valueType),
  }

  if (feature.description) out.description = feature.description
  const tagLabels = (feature.tags ?? [])
    .map((id) => tagLabelById.get(id))
    .filter((label): label is string => typeof label === 'string')
  if (tagLabels.length > 0) out.tags = tagLabels

  return out
}

/** Build the rule that triggers when a context is in `segmentName`. */
function buildSegmentOverrideRule(
  segov: FlagsmithFeatureState,
  segmentName: string,
  bundle: FlagsmithFeatureWithStates,
  ctx: FeatureContext,
): QuonfigRule {
  const {feature} = bundle
  const mvOptions = feature.multivariate_options ?? []

  let value: QuonfigRuleValue
  if (!segov.enabled) {
    if (ctx.valueType === 'bool') {
      value = {type: 'bool', value: false}
    } else if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
      ctx.report.add(
        'enabled-false-non-boolean',
        feature.name,
        `segment override "${segmentName}" is disabled — Flagsmith would have served your code's default; Quonfig now serves the stored weighted_values`,
      )
      value = multivariateWeightedValue(mvOptions, segov.multivariate_feature_state_values ?? [], ctx)
    } else {
      const stored = coerceEnvelopeOrScalar(segov.feature_state_value)
      ctx.report.add(
        'enabled-false-non-boolean',
        feature.name,
        `segment override "${segmentName}" is disabled — Flagsmith would have served your code's default; Quonfig now serves ${JSON.stringify(
          stored,
        )}`,
      )
      value = toQuonfigValue(stored, ctx.valueType)
    }
  } else if (feature.type === 'MULTIVARIATE' && mvOptions.length > 0) {
    value = multivariateWeightedValue(mvOptions, segov.multivariate_feature_state_values ?? [], ctx)
  } else {
    const raw = coerceEnvelopeOrScalar(segov.feature_state_value)
    value = toQuonfigValue(raw, ctx.valueType)
  }

  return {
    criteria: [
      {
        operator: 'IN_SEG',
        valueToMatch: {type: 'string', value: segmentName},
      },
    ],
    value,
  }
}

/**
 * Translate one Flagsmith segment into a Quonfig segment config object.
 *
 * Quonfig segments are boolean ("is the context in the segment?") and have no
 * per-environment state, so all rules collapse into `default.rules`,
 * first-match-wins. A rule whose conditions all map yields a true-valued rule;
 * a trailing ALWAYS_TRUE serves false (not in segment).
 */
export function translateSegment(segment: FlagsmithSegment, report: ConversionReport): Record<string, unknown> {
  const rules: QuonfigRule[] = []

  for (const rule of segment.rules ?? []) {
    const criteria = flattenSegmentRuleForSegment(rule, segment, report)
    if (criteria === null) continue
    rules.push({
      criteria: criteria.length > 0 ? criteria : [ALWAYS_TRUE],
      value: {type: 'bool', value: true},
    })
  }

  // Trailing catch-all: anyone not matched is not in the segment.
  rules.push({criteria: [ALWAYS_TRUE], value: {type: 'bool', value: false}})

  const out: Record<string, unknown> = {
    key: normalizeKey(segment.name),
    type: 'segment',
    valueType: 'bool',
    default: {rules},
    environments: [],
    variants: [],
  }

  if (segment.description) out.description = segment.description
  return out
}
