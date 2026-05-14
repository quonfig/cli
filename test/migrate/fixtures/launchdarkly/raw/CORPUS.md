# LaunchDarkly fixture corpus — raw Phase-1 JSON

This directory is the **canonical** raw-input corpus for the LaunchDarkly
migration converter. Every `fx-*.json` file is one LaunchDarkly flag or segment
as returned by the Phase-1 config-snapshot fetcher
(`src/migrate/sources/launchdarkly/api.ts`). The converter golden tests
(plan §6.1, downstream beads) build their `expected/` outputs against these.

Reference: `project/plans/migrator-launch-darkly.md` §6.1, §6.3, §10 Epic 4.
Source matrix: `competitor-launchdarkly/FIXTURE_MATRIX.md`.

## How it was generated

`scripts/export-ld-fixtures.ts` runs `fetchSnapshot()` against the live
`competitor-launchdarkly` LaunchDarkly account (project `default`), filters to
`fx-*` keys, and writes one JSON file per flag/segment plus `_snapshot-meta.json`
(environment + context-kind list). It also takes a second archived-only flag
pass — `fetchSnapshot` deliberately omits archived flags, the corpus needs them.

Re-run to refresh: `node --loader ts-node/esm scripts/export-ld-fixtures.ts`
(needs a LaunchDarkly REST API token; see the script header). Output is
deterministic — object keys are sorted — so a refresh produces a clean diff.

`launchdarkly-fixture-corpus.test.ts` is the freshness guard: it asserts the
corpus is present and substantial and that **every** raw fixture still converts
to schema-valid Quonfig via `translateFlag` / `translateSegment` + `validateFileMap`.

## What's in it

- **80 flags + 11 segments** exported from the live account (90 from the
  standard snapshot + `fx-state-archived` from the archived pass).
- **1 hand-authored flag** (`fx-soft-deleted-flag.json`) — see Backfilled below.
- `_snapshot-meta.json` — environments and context kinds, shared across fixtures.

## §6.3 fixture-gap dispositions

The fixture generator left holes (`competitor-launchdarkly/fixtures/` run
reports / `manifest.json`). Per plan §6.3, each is decided here:

| Gap                         | Disposition                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fx-state-archived`         | **Closed.** The exporter's archived-only pass (`fetchFlags(..., {archived: true})`) pulls it; the snapshot pass hides archived flags.                                                                                                                                                                                                      |
| `fx-meta-maintainer-id`     | **Closed — covered implicitly.** All 80 exported flags carry `maintainerId` (account owner), so the converter's `dropped-maintainer` path is exercised corpus-wide. A dedicated fixture would add no coverage.                                                                                                                             |
| `fx-meta-maintainer-team`   | **Out of scope.** No team exists in the account. The converter treats `maintainerTeamKey` identically to `maintainerId` (one `flag.maintainerId \|\| flag.maintainerTeamKey` branch), already covered. Provisioning a team is account-admin work with no converter-coverage payoff.                                                        |
| `fx-meta-purpose-migration` | **Out of scope for v1.** LaunchDarkly migration flags have bespoke variation semantics; the generator could not create one (400 "omit variations for a migration flag") and the converter has no `purpose`-aware handling (not in plan §5.4). Migration-flag support is a converter-epic decision (qfg-mol-guo), not a corpus-export task. |
| `fx-soft-deleted-flag`      | **Closed — hand-authored.** §6.3 calls this one out as "worth a fixture" (→ `QuonfigFile.deleted` tombstone). Soft-deleting a live flag is destructive and the generator skipped it for idempotency, but the raw shape is well-defined (a normal flag + `deleted: true`, matrix §11.7), so it is hand-authored from a representative flag. |

### AI Configs — out of scope for the raw corpus

The matrix provisions 16 `fx-ai-*` AI Configs. They are **not** in this corpus:
plan §5.4 / decision D9 puts AI Configs out of scope for the v1 converter
("no QuonfigFile is emitted"), and `fetchSnapshot` does not fetch them (AI
Configs are a separate `/ai-configs` resource). If a future epic adds AI Config
support, extend `export-ld-fixtures.ts` to fetch and write them here.

## Backfilled (hand-authored, not exporter output)

- `fx-soft-deleted-flag.json` — see the `_comment` field inside the file and the
  §6.3 table above. The exporter never overwrites it (it only writes keys the
  live account returns).
