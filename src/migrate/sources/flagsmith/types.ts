/**
 * Clean typed structs for the slice of the Flagsmith REST API the Phase-1
 * config-snapshot fetcher walks. Field names mirror Flagsmith's JSON exactly;
 * optional fields are the ones Flagsmith omits when unset.
 *
 * Reference: https://api.flagsmith.com/api/v1/swagger.json — `GET
 * /projects/{id}/`, `GET /environments/?project=`, `GET
 * /projects/{pk}/features/`, `GET /features/featurestates/?environment=`, `GET
 * /projects/{pk}/segments/`, `GET /features/feature-segments/?environment=`,
 * `GET /environments/{api_key}/edge-identities/`, `GET
 * /environments/{api_key}/edge-identity-overrides`, `GET
 * /projects/{pk}/tags/`.
 *
 * Verified empirically against the live `Test1` project on 2026-05-17 — see
 * `competitor-flagsmith/fixtures/CORPUS.md` API1..API9 for the quirks the
 * structural docs don't capture.
 */

/** Django REST style pagination envelope: `{count, next, previous, results}`. */
export interface FlagsmithPaginated<T> {
  count: number
  next: null | string
  previous: null | string
  results: T[]
}

/** Edge-identity listing uses cursor pagination via `last_evaluated_key`, not page numbers. */
export interface FlagsmithEdgeIdentityListResponse {
  last_evaluated_key: null | string
  results: FlagsmithEdgeIdentity[]
}

/** `GET /projects/{id}/` — project metadata, including the edge-identity branch flag. */
export interface FlagsmithProject {
  enable_dynamo_db?: boolean
  enable_realtime_updates?: boolean
  feature_name_regex?: null | string
  hide_disabled_flags?: boolean
  id: number
  migration_status?: string
  name: string
  only_allow_lower_case_feature_names?: boolean
  organisation: number
  prevent_flag_defaults?: boolean
  total_features?: number
  total_segments?: number
  /** If true, identities live under `/edge-identities/` (per-env UUIDs); else under `/identities/`. */
  use_edge_identities: boolean
  /** Affects WRITE-side paths only — read endpoints work the same on v1 and v2 envs. */
  use_v2_feature_versioning?: boolean
  uuid: string
}

/** `GET /environments/?project={id}` — env list, paginated. */
export interface FlagsmithEnvironment {
  /** Stable per-env identifier the SDK uses; also threaded into URL paths as `{environment_api_key}`. */
  api_key: string
  description?: null | string
  id: number
  name: string
  project: number
  use_v2_feature_versioning?: boolean
  uuid: string
}

/** One row of a feature's `multivariate_options[]` (inline on the feature resource). */
export interface FlagsmithMultivariateOption {
  boolean_value: boolean | null
  /** Project-level default weight — per-env overrides live on the featurestate's `multivariate_feature_state_values`. */
  default_percentage_allocation: number
  id: number
  integer_value: integer | null
  string_value: null | string
  /** Discriminator: `unicode` (string), `int`, `bool`. */
  type: string
  uuid: string
}

// Marker — TypeScript doesn't have `integer` as a distinct primitive; we keep
// the field comments calling it out for the reader and rely on `number` at
// runtime.
type integer = number

/** `GET /projects/{pk}/features/` row. Variations are inline as `multivariate_options[]`. */
export interface FlagsmithFeature {
  created_date?: string
  default_enabled: boolean
  description?: null | string
  group_owners?: number[]
  id: number
  initial_value?: null | string
  is_archived: boolean
  is_server_key_only?: boolean
  /**
   * **API6 caveat**: the live API returns these in REVERSE creation order. The
   * fetcher sorts by `id` ascending before exposing the feature to the
   * converter, so by the time `LegacyChange.raw` is consumed the order matches
   * definition order.
   */
  multivariate_options: FlagsmithMultivariateOption[]
  name: string
  num_identity_overrides?: integer | null
  num_segment_overrides?: integer
  owners?: number[]
  project: number
  tags: number[]
  /** `STANDARD` for boolean/value flags; `MULTIVARIATE` when MV options are populated. */
  type: string
  uuid: string
}

/**
 * The envelope shape for `feature_state_value` returned by
 * `/features/featurestates/?environment=` (the endpoint the fetcher uses for
 * per-env featurestates). Reads on the legacy `/environments/{api_key}/featurestates/`
 * endpoint return a scalar instead; we deliberately do not use that endpoint
 * because it does not surface segment-override rows on v2-versioned envs.
 */
export interface FlagsmithFeatureStateValueEnvelope {
  boolean_value: boolean | null
  integer_value: integer | null
  string_value: null | string
  type: string
}

/** One inline MV weight on a per-env featurestate (overrides the project-level default allocation). */
export interface FlagsmithMultivariateFeatureStateValue {
  id?: integer
  multivariate_feature_option: integer
  percentage_allocation: number
  uuid?: string
}

/**
 * A row from `GET /features/featurestates/?environment={id}` — the unified
 * per-env featurestate listing. Includes env-default rows (`feature_segment ==
 * null && identity == null`) AND segment-override rows (`feature_segment !=
 * null`). Identity overrides are NOT in this listing on edge-enabled projects
 * — see `/edge-identity-overrides` instead.
 */
export interface FlagsmithFeatureState {
  change_request?: integer | null
  created_at?: string
  enabled: boolean
  environment: integer | null
  /** Versions-API uuid; non-null on v2-versioned envs. Same value for env-default and segment-override rows on the same live version. */
  environment_feature_version?: null | string
  feature: integer
  /**
   * Inline feature_segment shape (id + segment id + priority + uuid) on the
   * `/features/featurestates/` endpoint, else just the numeric ID. Null when
   * this row is the env-default featurestate.
   */
  feature_segment: FlagsmithFeatureSegmentInline | integer | null
  /** Envelope shape on `/features/featurestates/`; scalar on legacy endpoints. */
  feature_state_value: FlagsmithFeatureStateValueEnvelope | boolean | integer | null | string
  id: integer
  identity?: integer | null
  live_from?: null | string
  multivariate_feature_state_values: FlagsmithMultivariateFeatureStateValue[]
  updated_at?: string
  uuid: string
  version?: integer | null
}

/** Compact feature_segment payload inlined on featurestate rows. */
export interface FlagsmithFeatureSegmentInline {
  id: integer
  priority: integer
  segment: integer
  uuid: string
}

/** One condition inside a segment rule (siblings AND together by default). */
export interface FlagsmithSegmentCondition {
  description?: null | string
  id?: integer
  /** Discriminator. 14-constant `ConditionOperatorEnum`; see plan §5.3. */
  operator: string
  property?: null | string
  value?: null | string
}

/** One rule inside a segment. Sibling rules under a parent rule AND or OR per `type`. */
export interface FlagsmithSegmentRule {
  conditions: FlagsmithSegmentCondition[]
  id?: integer
  rules: FlagsmithSegmentRule[]
  /** `ALL` (AND), `ANY` (OR), `NONE` (NOT-ANY). */
  type: string
}

/** `GET /projects/{pk}/segments/` row. Project-scoped (NOT per-env). */
export interface FlagsmithSegment {
  created_at?: null | string
  description?: null | string
  /** Non-null on "feature-specific" segments (created via the per-feature segment-override flow). */
  feature?: integer | null
  id: integer
  name: string
  project: integer
  rules: FlagsmithSegmentRule[]
  updated_at?: null | string
  uuid: string
  version_of?: integer | null
}

/**
 * `GET /features/feature-segments/?environment={id}&feature={fid}` row —
 * gives a segment's priority for one feature in one env. Used for
 * priority ordering when stitching segment-override rules.
 */
export interface FlagsmithFeatureSegment {
  environment: integer
  id: integer
  is_feature_specific?: boolean
  priority: integer
  segment: integer
  segment_name?: string
  uuid: string
}

/** `GET /environments/{api_key}/edge-identities/` row. Per-env `identity_uuid`; identifier is stable. */
export interface FlagsmithEdgeIdentity {
  dashboard_alias?: null | string
  identifier: string
  /** **API8 caveat**: this differs PER ENVIRONMENT for the same `identifier`. */
  identity_uuid: string
}

/**
 * One row from `GET /environments/{api_key}/edge-identity-overrides` — listed
 * across all identities in one env. Same shape as the per-identity
 * `edge-featurestates` rows.
 */
export interface FlagsmithEdgeIdentityOverride {
  feature_state: FlagsmithEdgeIdentityFeatureState
  identifier: string
  identity_uuid: string
}

/** Edge-identity featurestate read shape. Note: `feature_state_value` is SCALAR here, not envelope (API5). */
export interface FlagsmithEdgeIdentityFeatureState {
  enabled: boolean
  feature: integer
  feature_state_value: boolean | integer | null | string
  featurestate_uuid?: string
  identity_uuid?: string
  multivariate_feature_state_values: FlagsmithMultivariateFeatureStateValue[]
}

/** `GET /projects/{pk}/tags/` row. Pure metadata; the migrator emits string labels into Quonfig `tags[]`. */
export interface FlagsmithTag {
  color?: string
  description?: null | string
  id: integer
  is_permanent?: boolean
  is_system_tag?: boolean
  label: string
  project: integer
  type?: string
  uuid: string
}

/**
 * The full Phase-1 config snapshot — what the fetcher stitches together and
 * what `translate()` consumes. One of these is produced per migration run.
 *
 * Indexed by `env.api_key` rather than env name because (a) one of the two
 * `featurestates_by_env`/`feature_segments_by_env` maps below would otherwise
 * disagree about the key, and (b) api_key is the path-segment Flagsmith uses
 * in every per-env URL, so it's the canonical handle.
 */
export interface FlagsmithSnapshot {
  /** Environments in API order. */
  environments: FlagsmithEnvironment[]
  /** Per-feature stitched view of every featurestate (env-default + segment-overrides + identity-overrides). */
  features: FlagsmithFeatureWithStates[]
  project: FlagsmithProject
  /** Project-scoped segment pool, referenced by `feature_segments_by_env[*].segment`. */
  segments: FlagsmithSegment[]
  tags: FlagsmithTag[]
}

/**
 * One feature stitched with all of its per-env state. This is the shape that
 * goes into `LegacyChange.raw` as the per-feature payload.
 */
export interface FlagsmithFeatureWithStates {
  /** The feature record itself (mv_options sorted asc by id — API6). */
  feature: FlagsmithFeature
  /** Per-env priority + segment-id rows for this feature's segment-overrides. Keyed by env api_key. */
  feature_segments_by_env: Record<string, FlagsmithFeatureSegment[]>
  /** Per-env featurestates: env-default + segment-overrides + identity-overrides. Keyed by env api_key. */
  featurestates_by_env: Record<string, FlagsmithFeatureStateBundle>
}

/** Per-env featurestate bundle: env-default + segment-overrides + identity-overrides. */
export interface FlagsmithFeatureStateBundle {
  /** The env-level default featurestate (`feature_segment == null && identity == null`). May be absent on partial-fetch errors. */
  default: FlagsmithFeatureState | null
  /** Edge-identity overrides for this feature in this env. SCALAR `feature_state_value` (API5). */
  identity_overrides: FlagsmithEdgeIdentityOverride[]
  /** Segment-override featurestates (`feature_segment != null`), ordered ASC by priority via the feature_segments lookup. */
  segment_overrides: FlagsmithFeatureState[]
}
