/**
 * Clean typed structs for the slice of the LaunchDarkly REST API the
 * Phase-1 config-snapshot fetcher walks. Field names mirror LaunchDarkly's
 * JSON exactly; optional fields are the ones LD omits when unset.
 *
 * Reference: https://apidocs.launchdarkly.com/ — `GET /flags/{proj}?env=`,
 * `GET /segments/{proj}/{env}`, `GET /projects/{proj}/environments`,
 * `GET /projects/{proj}/context-kinds`.
 */

/** A LaunchDarkly clause — one predicate inside a rule (rule clauses AND together). */
export interface LDClause {
  _id?: string
  /** JSON-pointer-or-bare attribute name, e.g. "email" or "/address/city". */
  attribute: string
  /** Context kind the attribute belongs to. Absent ⇒ "user". */
  contextKind?: string
  negate?: boolean
  /** LaunchDarkly operator name, e.g. "in", "segmentMatch", "semVerLessThan". */
  op: string
  values: unknown[]
}

/** One weighted variation inside a rollout. */
export interface LDWeightedVariation {
  untracked?: boolean
  /** 0-based index into the flag's variations[]. */
  variation: number
  /** Integer weight; weights in a rollout sum to 100000 (= 100%). */
  weight: number
}

/** A percentage rollout — served by a rule or by the fallthrough. */
export interface LDRollout {
  /** Attribute to hash on. Absent ⇒ the context key. May be a JSON pointer. */
  bucketBy?: string
  contextKind?: string
  /** "experiment" marks an experiment rollout; v1 drops the experiment framing. */
  kind?: string
  seed?: number
  variations: LDWeightedVariation[]
}

/** A targeting rule inside a per-environment flag state. */
export interface LDRule {
  _id?: string
  clauses: LDClause[]
  description?: string
  /** Exactly one of `variation` / `rollout` is set. */
  rollout?: LDRollout
  trackEvents?: boolean
  variation?: number
}

/** Individual-target list — specific context keys pinned to one variation. */
export interface LDTarget {
  /** Absent on the legacy user-only `targets` array ⇒ "user". */
  contextKind?: string
  values: string[]
  variation: number
}

/** Single variation/default pointer or a rollout. */
export interface LDVariationOrRollout {
  rollout?: LDRollout
  variation?: number
}

/** Per-environment flag state, keyed by environment key in `flag.environments`. */
export interface LDFlagEnvironment {
  archived?: boolean
  contextTargets?: LDTarget[]
  fallthrough?: LDVariationOrRollout
  /** Index into variations[] served when `on` is false. */
  offVariation?: number
  /** The `on` toggle that sits above the rule engine. */
  on: boolean
  prerequisites?: Array<{key: string; variation: number}>
  rules?: LDRule[]
  salt?: string
  targets?: LDTarget[]
  version?: number
}

/** A flag variation — one of the typed values the flag can serve. */
export interface LDVariation {
  _id?: string
  description?: string
  name?: string
  value: unknown
}

/** A LaunchDarkly feature flag as returned by `GET /flags/{proj}?env=...`. */
export interface LDFlag {
  clientSideAvailability?: {usingEnvironmentId?: boolean; usingMobileKey?: boolean}
  customProperties?: Record<string, {name?: string; value: string[]}>
  description?: string
  /** Map of environment key → per-environment state. */
  environments: Record<string, LDFlagEnvironment>
  key: string
  /** "boolean" or "multivariate". */
  kind: string
  maintainerId?: string
  maintainerTeamKey?: string
  name?: string
  tags?: string[]
  temporary?: boolean
  variations: LDVariation[]
}

/** A LaunchDarkly segment as returned by `GET /segments/{proj}/{env}`. */
export interface LDSegment {
  description?: string
  excluded?: string[]
  excludedContexts?: Array<{contextKind: string; values: string[]}>
  included?: string[]
  includedContexts?: Array<{contextKind: string; values: string[]}>
  key: string
  name?: string
  rules?: Array<{_id?: string; bucketBy?: string; clauses: LDClause[]; weight?: number}>
  tags?: string[]
  /** Big/synced segment — membership is not exportable via the REST API. */
  unbounded?: boolean
  unboundedContextKind?: string
}

/** `GET /projects/{proj}/environments` — offset-paginated. */
export interface LDEnvironmentsResponse {
  _links?: {next?: {href: string}}
  items: Array<{key: string; name: string}>
  totalCount?: number
}

/** `GET /flags/{proj}?env=...` — offset-paginated. */
export interface LDFlagsResponse {
  _links?: {next?: {href: string}}
  items: LDFlag[]
  totalCount?: number
}

/** `GET /segments/{proj}/{env}` — offset-paginated. */
export interface LDSegmentsResponse {
  _links?: {next?: {href: string}}
  items: LDSegment[]
  totalCount?: number
}

/** `GET /projects/{proj}/context-kinds`. */
export interface LDContextKindsResponse {
  items: Array<{key: string; name?: string}>
}

/**
 * The full Phase-1 config snapshot — what the fetcher stitches together and
 * what `translate()` consumes. One of these is produced per migration run.
 */
export interface LDSnapshot {
  contextKinds: string[]
  /** Environment keys, in API order. */
  environments: string[]
  flags: LDFlag[]
  /** Segments de-duplicated by key across environments. */
  segments: LDSegment[]
}
