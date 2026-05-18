# Flagsmith Fixture Corpus (cli-side)

Canonical raw + expected pairs for the Flagsmith converter golden tests
(`flagsmith-golden.test.ts`) and round-trip tests (`flagsmith-roundtrip.test.ts`).

Refresh against the live `Test1` Flagsmith account by running
`cli/scripts/export-flagsmith-fixtures.ts`, then re-derive expected outputs
with `cli/scripts/generate-flagsmith-expected.ts`. Both are deterministic
modulo `snapshotTaken` so a regen produces a reviewable diff.

The live-account corpus catalogue is in
`competitor-flagsmith/fixtures/CORPUS.md` and
`competitor-flagsmith/FIXTURE_MATRIX.md`. This file mirrors the gap list
from the live side so a future matrix change has to update both at once.

## Totals (current commit)

- features: 20 (boolean/string/int + MV + cross-env + segov + idov + edge)
- segments: 24 (structural + per-operator)
- KNOWN_GAPS: 9 (mirrors live CORPUS.md)
- expected files: one per fixture, under `expected/<fixture>/<feature-flags|segments>/<key>.json`

## Categories covered

| Matrix section          | Fixtures in this corpus                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 value types           | fx-value-boolean-on, fx-value-boolean-off, fx-value-string-basic, fx-value-string-with-disabled, fx-value-integer-positive                                                                                                                                                                                            |
| 2 lifecycle/metadata    | fx-meta-with-description, fx-meta-tag-multi                                                                                                                                                                                                                                                                           |
| 3 multivariate          | fx-mv-string-3way, fx-mv-boolean-2way, fx-mv-per-env-divergence, fx-mv-with-disabled-default                                                                                                                                                                                                                          |
| 4 per-env divergence    | fx-env-enabled-diverges, fx-env-value-diverges                                                                                                                                                                                                                                                                        |
| 5 segments              | fx-seg-single-condition, fx-seg-and-within-rule, fx-seg-or-within-rule, fx-seg-none-within-rule, fx-seg-and-of-rules, fx-seg-empty-conditions, fx-seg-with-description                                                                                                                                                |
| 6 segment-condition ops | fx-op-equal, fx-op-not-equal, fx-op-greater-than, fx-op-greater-than-inclusive, fx-op-less-than, fx-op-contains, fx-op-not-contains, fx-op-regex, fx-op-in, fx-op-is-set, fx-op-is-not-set, fx-op-modulo, fx-op-percentage-split, fx-op-semver-equal, fx-op-semver-greater, fx-op-semver-less, fx-op-semver-inclusive |
| 7 segment overrides     | fx-segov-single, fx-segov-changes-value, fx-segov-multiple-priorities                                                                                                                                                                                                                                                 |
| 8 identity overrides    | fx-idov-single, fx-idov-on-boolean, fx-idov-and-segov-conflict                                                                                                                                                                                                                                                        |
| 9 versioning / CRs      | not in corpus — paywalled (see KNOWN_GAPS)                                                                                                                                                                                                                                                                            |
| 10 edge cases           | fx-edge-empty-string-value                                                                                                                                                                                                                                                                                            |

## KNOWN_GAPS (matrix rows we deliberately do NOT have)

These mirror the 9 entries in `competitor-flagsmith/fixtures/CORPUS.md` "Gaps"
section. The `flagsmith-golden.test.ts` asserts the length and that none of
them shows up in the corpus on disk — a future matrix change has to update
both files at once.

- **fx-seg-zero-rules** (segment) — `rules:[]` is rejected at create time by the live API.
- **fx-cr-create-only** (cr) — Workflows / change-requests are paywalled on the free-tier org.
- **fx-cr-approved-not-committed** (cr) — same paywall.
- **fx-cr-committed** (cr) — same paywall.
- **fx-cr-with-segment-override** (cr) — same paywall.
- **fx-cr-with-feature-state-value** (cr) — same paywall.
- **fx-edge-soft-deleted-feature** (edge) — no public read path exposes `deleted_at`; gap by design.
- **fx-ver-scheduled** (version) — scheduled changes via `live_from` require Flagsmith Scale-up.
- **fx-meta-feature-metadata** (meta) — project-level metadata fields aren't configured on Test1.

## Known SDK gap surfaced by this corpus

- **IS_PRESENT / IS_NOT_PRESENT unimplemented in `@quonfig/node` v0.0.24.**
  `fx-op-is-set` / `fx-op-is-not-set` golden tests pass (the converter emits
  the right operator), but the SDK evaluator falls through to `return false`
  in `flagsmith-roundtrip.test.ts`. Filed as a follow-up; the converter is
  correct.

## Provenance

The committed corpus is hand-authored against the Flagsmith API shapes
documented in `cli/src/migrate/sources/flagsmith/types.ts` and the
operator/structural conventions in `cli/src/migrate/sources/flagsmith/translate.ts`.
A live re-export from the Test1 account (project 38856) replaces every
file under `raw/` deterministically — only the `snapshotTaken` timestamp
and `fetcherSha` fields in `_snapshot-meta.json` differ on a clean run.
