# `qfg migrate --from launchdarkly`

This source imports a LaunchDarkly project into a Quonfig workspace. The full
design is ratified in `project/plans/migrator-launch-darkly.md` — this file is
the short, frozen summary; the plan is authoritative.

## Status

Implemented (v1 core): the Phase-1 config-snapshot fetcher, the shared
`cli/src/migrate/quonfig-target/` verb library, and the LaunchDarkly converter.
Both write modes (`--dir` local repo, `--push` hosted Gitea) are inherited from
the source-agnostic write paths. History backfill (`--full-summary`, Phase 2)
and the native schema-gap epics layer on after — see plan §10.

## Frozen design decisions (plan §9.1, ratified 2026-05-14)

- **D1 — no provider-neutral IR.** Quonfig _is_ the intermediate representation.
  `LegacyChange.raw` carries LaunchDarkly's native JSON; `translate()` goes
  straight to `QuonfigFile[]`. The shared core (`cli/src/migrate/quonfig-target/`)
  is a library of Quonfig-target _verbs_, not a neutral schema.
- **D2 — Phase 1 is always a full re-snapshot.** It is only ~60 API calls. We do
  not trust the LaunchDarkly audit-log cursor for delta correctness;
  `.qf/import-state.json` delta tracking still reports "what changed since last
  run", but Phase 1 re-fetches everything.
- **D3 — negated comparison / date / semver operators skip + report.** Quonfig
  has no negated form of any comparison operator and no within-rule OR, so an
  algebraic flip would need combinatorial rule expansion plus missing-attribute
  handling. v1 skips the clause and names the exact flag + clause in
  `MIGRATION_REPORT.md`. Negated `in` / `contains` / `startsWith` / `endsWith` /
  `matches` / `segmentMatch` are unaffected — they have direct negated operators
  and always convert.
- **D8 — generalized source API key.** `--source-api-key` (env
  `QUONFIG_MIGRATE_API_KEY`, plus per-provider `LAUNCHDARKLY_API_KEY`) is the
  forward-looking flag; `--api-key` / `LAUNCH_API_KEY` stay as deprecated aliases
  for the `launch` source. (Flag wiring lands with the write-mode epic.)
- **History policy — best-effort, provider-dependent.** Without `--full-summary`:
  current state only, always supported. With it: backfill whatever LaunchDarkly
  actually retained (Developer plans retain 30 days; Unlimited is
  Enterprise/select-plan only), after an up-front retention pre-flight check.

### Semver gap — CLOSED

`PROP_SEMVER_EQUAL` / `PROP_SEMVER_LESS_THAN` / `PROP_SEMVER_GREATER_THAN` are
confirmed present in the Quonfig operator enum
(`app-quonfig/src/lib/domain/config-schemas.ts`). LaunchDarkly's `semVerEqual` /
`semVerLessThan` / `semVerGreaterThan` map directly. (`IS_PRESENT` /
`IS_NOT_PRESENT` and `IN_SEG` / `NOT_IN_SEG` are likewise present.) The previous
"semver operators" schema gap no longer exists.

## Known gaps — v1 disposition (skip + report, never silent)

| LaunchDarkly concept         | v1 behavior                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisites                | Skip + report. Native cross-flag dependency support is a schema epic gated by D7.                                                                                                                        |
| Individual / context targets | Converted to a leading `PROP_IS_ONE_OF` rule on the identifier attribute (semantics-preserving for evaluation order; the LD UI affordance is lost — reported).                                           |
| Experiment rollouts          | Converted to plain `weighted_values`; `kind: "experiment"` + `seed` dropped + reported.                                                                                                                  |
| `privateAttributes`          | Dropped + reported. Native support is a cross-service epic.                                                                                                                                              |
| AI Configs                   | Out of scope for emitted output; report-only.                                                                                                                                                            |
| `bucketBy` (incl. nested)    | Maps to `weighted_values.hashByPropertyName`; nested `/a/b` → dotted `a.b`. Bucketing algorithm differs from LD — every percentage rollout is listed under a "users will be re-bucketed" report heading. |
| Big / synced segments        | Membership is not exportable via REST. The segment shell + rules are emitted; "membership unavailable" is recorded.                                                                                      |
| Maintainer metadata          | Dropped + reported (Quonfig authorship lives in git history).                                                                                                                                            |
| `clientSideAvailability`     | `usingEnvironmentId` → `sendToClientSdk`; the mobile-key dimension is dropped + reported.                                                                                                                |
| `customProperties`           | Report-only in v1 (see D6).                                                                                                                                                                              |

Every skip/drop path produces a structured report entry. Nothing is silently
dropped.

## Still-open decisions (plan §9.2 — resolve at the gating epic)

- **D4** — `offVariation` on an _on_ flag: drop + report vs. a new schema field.
- **D5** — clause referencing the `kind` attribute itself: needs a property-name
  convention.
- **D6** — `customProperties`: report-only vs. fold into `description` vs. new
  schema field.
- **D7** — schema-gap epics (prerequisite operator / individual-target primitive
  / `privateAttributes`): are we committing to ship any natively, or is v1
  permanently skip + report?
- **D9** — v1 scope for AI Configs: is report-only acceptable?

See `project/plans/migrator-launch-darkly.md` §9.2 for the full text.
