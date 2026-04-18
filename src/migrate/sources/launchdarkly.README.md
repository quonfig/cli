# `qfg migrate --from launchdarkly` — stub

This source is a stub. All methods throw `NotYetImplementedError`. Before it can become real, the gaps below must be resolved. Each gap is a multi-service change (Quonfig JSON schema + every SDK evaluator + `api-delivery` cache/delivery) and therefore requires a `blocked:human` bead filed against the epic.

The schema-gap beads are intentionally **not filed yet** — they would sit unblockable. File them when someone commits to shipping `--from launchdarkly`.

## Known schema gaps

### 1. Prerequisite-flag operator

LaunchDarkly rules can depend on another flag's evaluated variation (`prerequisites: [{key, variation}]`). Quonfig has no operator that references another flag's evaluation result. Adding one touches:

- Quonfig JSON rule schema (new operator)
- All SDK evaluators (resolve prerequisite recursively, detect cycles)
- `api-delivery` (prerequisite graph must be loaded alongside the target flag)

### 2. Individual-user targets

LD flags carry a per-environment `targets: [{variation, values: [userKey, ...]}]` list — a first-class "these specific user keys get this specific variation" primitive, separate from the rule engine. Quonfig has no individual-target primitive; these must currently be expressed as equality-on-identifier rules, which loses the LD semantics (targets evaluate before rules and have their own UI affordance). Adding a native primitive touches the rule schema and every evaluator.

### 3. `privateAttributes`

LD flags/projects carry a `privateAttributes` list declaring which user-context attributes must never be sent to LD servers in analytics events. Quonfig has no equivalent concept (no "don't exfiltrate this attribute" marker). Adding it touches context/identity schema, every SDK's telemetry path, and `api-telemetry` ingestion.

### 4. Semver operators

LD supports `semVerEqual`, `semVerGreaterThan`, `semVerLessThan` for comparing version strings per semver rules (not lexicographic). Quonfig currently has only string and numeric comparison operators. Adding semver operators touches the rule schema and every SDK evaluator (each language needs a semver parser wired in).

### 5. Audit-log delta strategy

LD's audit-log API may not support cursor-stable delta fetch. If the cursor is not stable (pagination shifts when new events arrive, or events are not strictly ordered by a monotonic field we can store), the incremental `fetchChanges(sinceEpochMs)` contract cannot be honored honestly. Likely fallback: full reimport on every run + diff against the last import snapshot. This is a source-specific implementation choice, not a schema change, but it materially affects how migration state is tracked for LD and should be decided before implementation.

## Stub behavior

All methods on `launchdarklySource` throw `NotYetImplementedError`. The error message includes a link to file a bead so users asking for this source surface demand:

```
qfg migrate --from launchdarkly is not yet implemented (<operation>). File a bead to prioritize this source: <github issue url>
```

When the gaps above are resolved and someone is ready to build this source, replace the stub with a real implementation and delete this README.
