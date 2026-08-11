# Changelog

## 0.0.72 - 2026-08-11

- fix(get): `qfg get` now prints **only the value** on stdout — the resolve/decrypt diagnostics ("This config is provided by env var …", "Successfully resolved config … from env var", "This config is encrypted by key … that should be found in env var …", "Successfully decrypted config …") moved to **stderr**. They were on stdout, ahead of the value, so a shell command substitution (`KEY=$(qfg get my.secret --environment production)`) captured the chatter along with the value; in the incident that prompted this, the polluted value was passed as a `Bearer` header and the downstream error echoed the whole blob — including the decrypted secret — into the logs. Only `providedBy`/`decryptWith` configs printed these lines; plain values were always clean. **If you added a `| tail -1` workaround you can drop it — and it keeps working either way**, since the value is still the last (now only) line on stdout. `--json` output is unchanged: those lines were already suppressed under `--json` and still are. (qfg-zvef)
- fix(workspace): `qfg workspace` no longer reports "(no workspaces yet — `qfg workspace create` to add one)" when the real problem is an expired login. Per-org token-refresh failures were swallowed, so a dead session produced an empty list that rendered as an empty account — telling a user with a perfectly good workspace that they had none, and nudging them toward creating a duplicate. (`qfg pull` and `qfg get` surfaced the same failure correctly; only the workspace listing swallowed it.) Now: if **every** org fails auth, the command exits 401 with the same "Session expired … Run `qfg login` to re-authenticate." error the other commands use; if **some** orgs fail, the healthy ones still list (one dead org must not blank out the others in a multi-org account) and each failed org gets a stderr warning naming `qfg login` plus a "(could not list workspaces)" line instead of a false "empty" one. Under `--json`, where warnings are suppressed, the payload carries a new `failedOrgs[]` array. (qfg-t15h)
- fix(push): a 403 push denial now prints the server's reason once, without duplicating the path or the permission slug. The clone/pack path appended `, requires <permission>` to a reason that already ends with that slug (and prefixed a path column the reason already names), so a protected-environment denial showed both twice; the bare-path engine had the opposite bug — it printed only `<path>: missing permission <slug>` and dropped the server's reason entirely, so the _why_ (which environment is protected, which rule reaches the default value) never reached the user. Both engines now render the reason and add back only the path/slug it does not already carry. Cosmetic + diagnostic only — which pushes are denied, and the named permission, are unchanged. (qfg-szte)

## 0.0.71 - 2026-07-31

- feat(auth): `QUONFIG_API_KEY` now accepts service-account keys (`qf_sa_` prefix) alongside user keys (`qf_uk_`). Service accounts are machine principals whose keys carry the new prefix (server side lands in app-quonfig, plan 2026-07-claude-tag-mcp-service-accounts Part 1); the headless-auth prefix check accepts either prefix, names both in its rejection message, and every other key path treats the two identically. (qfg-qw5i.6)
- fix(verify): `qfg verify --json` on an invalid workspace now emits the JSON result before exiting non-zero. The command called `this.exit(1)` — which throws — _before_ the JSON return/print path, so a failing `--json` run exited with code 1 but **empty stdout**, making `--json` useless exactly when there were findings to report. The result (`valid: false` plus the `issues`/`stats`) is now written to stdout first and exit code 1 is preserved, matching the `migrate doctor` emit-then-exit idiom. Human (non-`--json`) output was already correct and is unchanged. (qfg-ez47)

## 0.0.70 - 2026-07-14

- fix(generate): `qfg generate` no longer aborts (writing NOTHING) when two Policy-A-legal keys camelCase to the same accessor identifier — `my-flag`, `my_flag`, and `my.flag` legally coexist but all mangle to `myFlag()`, and the generator threw on the collision. Colliding identifiers are now deduplicated deterministically: within a colliding group, keys sort lexicographically, the first keeps the plain identifier, and the rest get numeric suffixes (`myFlag2()`, `myFlag3()`), skipping any identifier already claimed by another key (including a literal `myFlag2` key). A warning lists each colliding group's `key -> identifier` mapping. String lookups (`get('my_flag')`) are unaffected, and workspaces without collisions produce byte-identical output to before. Applies to both generators (node and react); the react generator dedups its client-side-filtered set, so a collision among server-only keys never affects or warns in react output. (qfg-hbuy.8)
- fix(schema): the published stored-config JSON Schema (`qfg config-schema --json-schema`) now describes the `key` property with the SAME bounds the prod `qfg-verify` hook actually enforces — Policy A charset `^[A-Za-z0-9._-]+$` and a 200-char cap — instead of the old loose `maxLength: 512` + `^[^/\\]+$`. Before this, a config file whose key was, say, 300 chars or contained a space validated green against our own published schema in a customer's editor and was then hard-rejected at push time. The schema now matches enforcement so editor-time validation and push-time validation agree. (The hook additionally enforces the FS-safety floor — no leading/trailing dot, no Windows reserved device names — which a JSON Schema `pattern` can't express cleanly; the charset and cap are the parts that fit.) (qfg-hbuy.9)
- fix(create): `qfg create` now mirrors the two FS-safety floor refinements app-quonfig's `PolicyAKeySchema` gained (qfg-hbuy.6), so create-time key validation is byte-identical on both surfaces and a bad key fails with a clear client-side error instead of a confusing 422 at push time. A key that ends with a dot or space (`foo.`, silently stripped on Windows) is rejected, as is a key whose first dot-segment is a Windows reserved device name (`con`, `CON`, `com3.foo` — `com10`, `console`, `foo.con` remain legal). The charset check already covered the hook's control-char and reserved-char floor items; these two are the only floor items the charset alone permitted. The reserved-name regex is kept byte-identical to app-quonfig `config-schemas.ts` and the `qfg-verify` hook's `validate.ts`. (qfg-hbuy.6)
- fix(migrate): a LaunchDarkly project with a flag and a segment sharing one source key no longer aborts the whole migration. LD flags and segments are separate key namespaces, but the migrator's shared key map resolved both to the same final key, wrote `feature-flags/<k>.json` AND `segments/<k>.json`, and the duplicate-key check fail-stopped the run ("Unexpected cross-type key collision"). Segment keys now plan in their own namespace: on a collision the flag keeps the clean name and the segment gets a deterministic `-segment` suffix (disambiguating around every other key, so it can never steal a different valid key's name), with every `IN_SEG`/`NOT_IN_SEG` reference following the rename. The rename is listed in `MIGRATION_REPORT.md` ("Rewritten keys") and the namespaced mapping persists in `.qf/key-plan.json` — the file gains a `segmentKeys` map and bumps its `version` to 2 **only when** the collision actually occurs; all other workspaces keep the byte-stable version-1 file, and version-1 files remain fully readable. Segments that don't collide with a flag are planned exactly as before (clean names, bare entries in the plan). (qfg-hbuy.10)
- fix(migrate): `schemaKey` and `decryptWith` references now follow key renames on Launch imports. Both fields reference OTHER keys — `schemaKey` points a config at its schema, `decryptWith` names the config holding a value's AES-GCM key — but the Launch converter passed them through verbatim, so when the referenced key was itself sanitized/renamed by the key rewriter the reference dangled (a dangling `decryptWith` = a config that can no longer decrypt). Both are now rewritten through the final key map wherever they appear (`schemaKey` on the config; `decryptWith` on default rules, per-environment rules, weighted-value entries, and variants). A reference whose key is NOT in the map points at a pre-existing workspace key the import does not own and is deliberately left untouched — never speculatively sanitized. LaunchDarkly and Flagsmith sources cannot carry either field (no such concept in their data models, and their converters build Quonfig output from scratch), so the fix is Launch-only by construction. (qfg-hbuy.11)
- fix(migrate): importing a key that collides case-insensitively with a key ALREADY in the target workspace no longer aborts the migration. The key rewriter only knew about the import set, so importing `Foo` into a workspace that already had `foo` (created via the UI, or by any earlier tool that left no key plan) sailed through planning and failed at the verify gate — worse, on a case-insensitive macOS/Windows clone the write itself could clobber the existing file first. The rewriter is now seeded with every key on disk in the target workspace (push mode reads the clone; `--dir` mode reads the reuse/pulled dir): a **byte-equal** incoming key keeps today's behavior — silent overwrite, the intentional re-migration/update path — while a **case-variant-only** collision deterministically renames the incoming key via the existing suffix machinery (`Foo` → `Foo-2`) and lists it in `MIGRATION_REPORT.md` with the existing workspace key named. Disambiguation suffixes skip existing keys entirely, so a renamed key can never clobber an unrelated existing one. The persisted `.qf/key-plan.json` stays authoritative; workspace seeding only fills in what the plan doesn't cover. Audit-log (`--full-summary`) pushes now also re-plan against the freshly-cloned workspace before the first per-change commit, so they honor the cloned key plan and existing keys the same way collapsed pushes do. (qfg-hbuy.12)
- fix(verify): closed the remaining file-enumeration bypasses in `qfg verify` and the app-gitea `qfg-verify` pre-receive hook (qfg-hbuy.4). Within the validated content dirs (`configs/`, `feature-flags/`, `segments/`, `log-levels/`, `schemas/`, `schemas-protected/`), three kinds of entry were silently **skipped** rather than validated — "ghost" files that push fine but no loader ever reads: dotfiles (`configs/.evil.json` — which also made the FS-floor's leading-dot check unreachable from the file walk), nested paths (`configs/sub/x.json` — the hook's `ls-tree` was non-recursive, so subdirectory contents were invisible), and case-variant extensions (`configs/FOO.JSON` — worse than inert, since it can collide with `foo.json` on a case-insensitive macOS/Windows clone, the exact clonability failure Policy A exists to prevent). All three are now **hard errors** at the committed-tree boundary (the hook and `validateFileMap`), as is any non-`.json` file in those dirs. The local disk walk (`qfg verify` / `qfg push` preflight) hard-errors on subdirectories and non-lowercase-`.json` files, warns on `.json`-looking dotfiles, and still silently ignores inert OS junk like `.DS_Store` (which `qfg push` never sends). Legitimate non-config paths (`quonfig.json`, `README.md`, the `.qf/` bookkeeping dir) are unaffected. app-quonfig's push-path allow-list was aligned in the same change, so every write channel now agrees. Deployed only after a full-corpus enumeration verified zero existing ghost entries in production workspaces.

## 0.0.69 - 2026-07-10

- feat(verify): `qfg verify` (and the app-gitea `qfg-verify` pre-receive hook, once redeployed) now **hard-errors** on a weighted rollout whose weights are neither an even split (all weights equal and > 0) nor percentages summing to 100000. Both valid forms are exactly what the app-quonfig editor writes ("Split evenly" stores all-equal weights; typed percentages store 1000 units per percent). Anything else was written by a broken client and silently mis-serves traffic: evaluators normalize by total weight, so stored `100000/80000` serves 55.6%/44.4% no matter what a display of the raw weights suggests (the Form Health incident, qfg-wis6). A fleet scan on 2026-07-10 verified every production workspace HEAD already satisfies the predicate, so no existing workspace is affected. (qfg-wis6.10)
- feat(migrate): imported rollout weights are now normalized to satisfy the same predicate. All-equal weights import verbatim (Launch's `1/1` rollouts are the canonical even-split encoding, not a bug); any other non-conforming ratio is scaled to sum 100000 (largest remainder, ties to the earliest index) and a zero total becomes an even split of ones. Serving ratios are unchanged — SDKs already normalize by total — this only makes the stored form canonical. Every adjustment is listed in `MIGRATION_REPORT.md` under "Normalized rollout weights". Applies to all three sources (Launch, LaunchDarkly, Flagsmith). (qfg-wis6.11)

## 0.0.68 - 2026-07-06

- feat(cli): `-w` is now accepted as the short alias for `--workspace` on `qfg push`, `qfg pull`, `qfg init`, and `qfg migrate`. `-w` already worked on every other workspace-aware command (`qfg get`/`run`/`list`/`generate`/…), but these four declared their own `--workspace` flag without the short char, so `qfg push -w my-ws` errored with `Nonexistent flag: -w`. The alias is now uniform across the CLI. Purely additive and backward-compatible — passing `-w` to these commands previously only ever produced an error. (qfg-qdcb)

## 0.0.67 - 2026-07-03

- feat(verify): the Policy A key charset (`^[A-Za-z0-9._-]+$`) is now a **hard error** in `qfg verify` (and the app-gitea `qfg-verify` pre-receive hook) — the final stage of the warn→error rollout begun in 0.0.66. A key outside the charset now fails verification and cannot be pushed. Flipped only after a full-corpus enumeration of every production workspace (2026-07-03) verified zero non-conforming stored keys, so no existing workspace is affected. Create (`qfg create`, app-quonfig API) and migrate already hard-enforce the same rule, so all boundaries now agree. (qfg-6na9.6)
- fix(verify): the `qfg-verify` pre-receive hook can no longer be bypassed by "unusual" filenames. The hook read the pushed tree with string-interpolated `execSync` calls and default `git ls-tree` output, so a filename containing a space (shell word-splitting) or non-ASCII characters (git's C-quoting of unusual paths) was **silently skipped and never validated** — exactly the Policy-A-violating keys the hook exists to catch (confirmed live on staging: a `configs/bad charset key.json` push was accepted unvalidated). File listing now uses `ls-tree -z` and all git invocations use `execFileSync` (no shell), and a listed-but-unreadable file now rejects the push (fail closed) instead of being skipped. (qfg-6na9.6)
- fix(migrate): an already-valid source key can no longer lose its name to a sanitized one. Key-rewrite planning is now two-pass: keys that already conform to Policy A and the FS-safety floor claim their own names first and are never renamed; sanitized keys disambiguate around them. Previously, with `my flag` and `my-flag` in the same import, `my flag` was rewritten to `my-flag` and the already-valid `my-flag` was renamed to `my-flag-2` — so customer code calling `get("my-flag")` silently evaluated the wrong flag. Two valid keys that collide case-insensitively (`Foo`/`foo`) remain a genuine source conflict, resolved deterministically (lexicographically-first keeps its name).
- fix(migrate): incremental (delta) re-runs now resolve keys exactly as the original full run did. The complete source→final key mapping (including unchanged keys) is persisted to `.qf/key-plan.json` and is authoritative on every subsequent run: previously-mapped keys keep their finals, and new keys can never claim a final owned by the plan. Before this fix a delta run (the default on dir reuse for Launch imports, or any `--recent`/`--since` run) replanned over only the fetched subset, so a key that resolved to `my-flag-2` in the full run could resolve to `my-flag` in the delta and silently overwrite a different flag's file. Also freezes mappings across future sanitizer-rule changes. `.qf/key-map.json` (the per-run rewrites report) is unchanged, except a run with zero rewrites now removes a stale map left by a prior run.
- fix(migrate): the key sanitizer no longer rewrites valid dash-edged keys. `-foo-` is fully legal under Policy A and the FS-safety floor, but was trimmed to `foo` — which also made `--strict-keys` abort on a perfectly valid key. Leading/trailing dots (and trailing whitespace) are still trimmed — those are real floor violations. The sanitizer is now an identity on every key that passes both validators (fuzz-verified with a seeded property test).

## 0.0.66 - 2026-07-01

- feat(create): `qfg create` now hard-enforces the Policy A key charset (`^[A-Za-z0-9._-]+$`, ≤ 200 chars, not `"new"`, no leading dot) client-side, failing fast with a clear error before the network round-trip. The app-quonfig create API already hard-enforces the same rule (qfg-6na9.1); this mirrors it client-side so a bad key is rejected immediately rather than after a server round-trip. Covers config, boolean-flag, and log-level creation. (qfg-6na9.2)
- feat(migrate): `qfg migrate` now rewrites imported keys so every migrated workspace is 100% Policy-A-conformant, instead of importing them verbatim. A key that is not filesystem-safe, or that contains characters outside `[A-Za-z0-9._-]`, is deterministically sanitized (path separators → `.`, other disallowed characters → `-`, leading/trailing separators trimmed, Windows reserved device names escaped, capped at 200 chars); two source keys that would collide (including case-insensitively) are disambiguated with a numeric suffix. Crucially, references are rewritten in lockstep with definitions — a renamed segment key and every `IN_SEG`/`NOT_IN_SEG` rule that targets it resolve to the same new key, so targeting never dangles. Every rewrite is listed in `MIGRATION_REPORT.md` ("Rewritten keys") and a machine-readable `.qf/key-map.json` so you can update your SDK lookups. LaunchDarkly keys already conform, so LD imports are unaffected (zero rewrites). A new `--strict-keys` flag refuses to migrate — rather than rewriting — if any key would change, for teams that require byte-identical keys. (qfg-6na9.3)
- feat(verify): `qfg verify` (and the app-gitea `qfg-verify` pre-receive hook) now emits a **warning — not an error** — for a key outside the Policy A charset `^[A-Za-z0-9._-]+$`. This is the warn stage of a warn→error rollout: a config that trips it still verifies and still pushes. The charset is hard-enforced only at **create** time (`qfg create` above, and the app-quonfig API) and at **migrate**; verify does **not** hard-reject a charset-violating key yet — that flip ships later, after a soak (qfg-6na9.6). The filesystem-safety floor and case-insensitive duplicate checks from 0.0.65 remain hard errors. (qfg-6na9.5)
- feat(update-check): `qfg` now surfaces an "update available" notice on stderr when a newer version has been published to npm, via the official `@oclif/plugin-warn-if-update-available` plugin. The notice includes the upgrade command (`Run npm i -g @quonfig/cli to upgrade.`). The version check is cached under the CLI cache dir and refreshed in a detached background process, so it never adds latency to a command, and the notice is written to stderr (via oclif `warn`) so it never contaminates stdout or piped output. Pinned to `3.0.16` — the newest release that still targets our `@oclif/core ^3`: `3.0.17`–`3.0.19` regressed the message renderer to a bare `import('lodash')` + `lodash.template`, which throws `lodash.template is not a function` under Node ≥18 (the export lives at `.default.template`); the hook swallows that error so no notice would ever print. The properly fixed `3.1.x` line switched to `lodash.default.template` but requires `@oclif/core ^4`, so it is not yet usable here.

## 0.0.65 - 2026-06-30

- feat(verify): `qfg verify` (and `qfg push`'s preflight, which runs verify) now hard-errors on filesystem-unsafe config/flag keys and on case-insensitive duplicate keys, matching the validation the app-gitea `qfg-verify` pre-receive hook already enforces server-side (qfg-6na9.4). Until now this validation lived only in the compiled server-side hook, so a bad key was caught only after the pack reached the cloud; running it in local preflight surfaces a clear, actionable error before anything is sent (and ahead of the server rejection -- a companion app-quonfig fix maps that rejection to a clean `HTTP 422` carrying the reason rather than the previous opaque `HTTP 500`). The Policy A production audit found zero existing keys that violate any of these rules, so no existing workspace is affected. Specifically:
  - Key length cap lowered from 512 to 200 characters. A key becomes a `<key>.json` filename in a git repo customers clone onto macOS/Windows machines; 200 chars leaves ample headroom under the 255-byte filesystem path-component limit even with the `.json` suffix.
  - New hard errors for keys that produce un-clonable or invisible files on a customer's checkout: a leading dot, control characters / NUL, Windows-reserved characters (`: * ? " < > |`), Windows reserved device names (`con`/`prn`/`aux`/`nul`/`com1`-`com9`/`lpt1`-`lpt9`), and a trailing dot or space.
  - Case-insensitive duplicate detection: two keys in a workspace that differ only by case (e.g. `Foo`/`foo`, `MyFlag`/`myflag`) now error with a distinct "differ only by case" message -- they collide to a single file on case-insensitive macOS/Windows clones, silently dropping a config.
  - The general Policy A charset rule (`^[A-Za-z0-9._-]+$`) is intentionally NOT part of this release; it ships later as a warning, then a hard error, after a soak (qfg-6na9.5 / qfg-6na9.6). (qfg-6na9.4)

## 0.0.64 - 2026-06-10

- fix(migrate): the LaunchDarkly importer no longer writes a junk `propertyName` (e.g. `user.segmentMatch`) onto segment-match criteria. LD `segmentMatch` clauses have no real attribute, but the clause converter normalized the pseudo-attribute into `propertyName` on every `IN_SEG`/`NOT_IN_SEG` criterion. Evaluation was unaffected (segment match keys off `valueToMatch`), but the criterion was non-canonical and previously rendered as an empty Property bubble in the app's rule editor. Segment criteria now serialize as operator + `valueToMatch` only, matching what the app editor expects and what the Launch importer already emits. Existing imports need no re-run — the stray field is ignored everywhere. (qfg-gc3u)

## 0.0.63 - 2026-06-07

- fix(info): `qfg info <key>` no longer crashes with `Cannot read properties of undefined (reading 'bool')`, and now actually renders evaluation stats. The command read the `analytics/evaluationStats` response with the wrong field names — `count`/`selectedValue` (an object) — but the endpoint returns ClickHouse `EvalStatRow[]` with `total` and `selected_value` (a JSON-encoded string like `{"bool":false}`). As a result every total summed to 0, so `qfg info` printed "No evaluations found for the past 24 hours" even for flags with real traffic, then threw on the undefined value while building its output. The 24h eval breakdown (per-environment counts and value percentages) now displays correctly, and rows with a missing/unparseable value render as `unknown` instead of throwing. Display-only fix — no change to what the server returns. (qfg-nkpe)

## 0.0.62 - 2026-06-06

- chore(deps): bump `@quonfig/node` to `^1.0.0` to track the stable Quonfig Node SDK 1.0.0 release. No CLI behavior change — the SDK is API-identical to 0.0.37.

## 0.0.61 - 2026-06-05

- fix(workspace): a directory's `quonfig.json` `workspace` pin is now authoritative over the active profile when resolving which workspace `qfg pull`, `qfg push`, and `qfg sync` target. Resolution precedence is now `--workspace` flag → `QUONFIG_WORKSPACE` env → `quonfig.json` pin → active OAuth profile. Previously the pin was never consulted as a resolution source — only as a guard — so a bare `qfg pull`/`qfg sync` in a pinned dir resolved to whatever the active profile pointed at. With an unrelated active profile (e.g. a `semgrep-test-1` default), `qfg sync --dir ./our-config` silently rewrote that dir's git `origin` to the wrong workspace on every poll and fetched it in, producing a phantom "diverged" state against unrelated history. A pinned dir is now self-describing: bare commands in it target the pinned workspace regardless of the global default. (qfg-08i)
- fix(sync): `qfg sync` now refuses to rewrite `origin` when the directory's existing remote points at a different workspace than the one being synced, instead of clobbering it. It reuses the same multi-remote guard `qfg pull` already runs, and errors with the configured-vs-expected remotes so the mismatch is obvious. (qfg-08i)

## 0.0.60 - 2026-05-30

- fix(workspace): `QUONFIG_WORKSPACE` (and `--workspace`) now require the org-qualified `org/workspace` form in `QUONFIG_API_KEY` (CI/headless) mode, matching every other surface — `quonfig.json`, the interactive shell, and all error messages. Previously the API-key path matched on the bare workspace slug while the OAuth path and `quonfig.json` required `org/workspace`, so test-`*` apps and CI had to special-case a bare `prod-testing` against `mhw-works/prod-testing` used everywhere else. A bare slug now fails fast with the same migration message the OAuth path emits, the org component disambiguates a slug shared across orgs, and the not-found error lists org-qualified pins (`org/workspace`) rather than bare slugs. UUIDs are still accepted directly. (qfg-dl87)

## 0.0.59 - 2026-05-29

- fix(migrate): `qfg migrate --from launch` is now resilient to transient Reforge API failures. Requests to the change-history endpoint retry on HTTP 429 and 5xx with exponential backoff + jitter, and pages are paced with a small inter-request delay — bringing the Launch importer up to the resilience the LaunchDarkly and Flagsmith importers already had. A 403 now fails fast with the response body surfaced, instead of being retried: a 403 from Reforge is an authorization failure or a server-side firewall block that does not clear by waiting, so retrying only delayed the error. (Surfaced by a form-health migration where a Reforge WAF rule briefly 403'd change-history requests whose pagination cursor contained certain flag-key substrings; the rule was fixed on the Reforge side.)

## 0.0.58 - 2026-05-29

- fix(migrate): `qfg migrate --push` (and any `cloneAndStackPush` clone-reuse) now re-points the local clone's `origin` at the freshly-minted Gitea token before fetching or pushing. Re-running a push from a directory used on a previous run reused the _stale_ token baked into `origin` at clone time — write-scope PATs are 1h TTL (and tokens can be swept), so that embedded credential was frequently dead and git failed with `remote: Failed to authenticate user` / `Authentication failed`. A fresh `--dir` worked (clone-path mints a live token) while an existing dir kept failing, which masqueraded as an intermittent server-side auth race. The reuse branch now runs `git remote set-url origin <fresh-url>` so every network op uses the live token, not the one captured at clone time. (qfg-fsdj)

## 0.0.57 - 2026-05-28

- fix(cleanup): `qfg cleanup remove` now emits forward-slash payload paths on Windows (e.g. `.qf/cleanup/<key>.json`) instead of backslashes, matching the docs and the gitignore entry. v0.0.56 was tagged but never published — Windows CI caught the path-separator divergence in `cleanup remove`'s next-step output / `--json` payloadPath, plus a CRLF-vs-LF mismatch in the `qfg-flag-cleanup` skill structural test. This release ships the same `qfg cleanup` workflow as v0.0.56 with those three failures fixed.
- feat(cleanup): new `qfg cleanup` command family that turns the `readyForCleanup` flag state into an end-to-end retirement workflow. `qfg cleanup list` shows every flag flagged ready-for-cleanup with eval-volume sparklines (24h / 2d / 7d / 30d windows) and rule state; `qfg cleanup status <key>` drills into one. `qfg cleanup remove <key>` is the handoff — it validates `readyForCleanup=true`, refuses if `evals_2d > 0` unless `--force`, writes a structured `.qf/cleanup/<key>.json` payload (flag shape per env, sparkline summary, SDK grep patterns, flag URL) into the current repo, and prints next-step instructions pointing at the new `qfg-flag-cleanup` Claude skill. `qfg cleanup verify <key>` is a non-mutating gate that confirms zero evals in the trailing N days (default 7) and exits non-zero otherwise, so you can chain `qfg cleanup verify <key> && qfg delete <key>` once the cleanup PR has merged. Modeled on `qfg migrate my-code` — the CLI writes a payload, the skill applies the change. (qfg-olm2.1, qfg-olm2.3, qfg-olm2.4)
- feat(qfg-flag-cleanup skill): new `cli/.claude/skills/qfg-flag-cleanup/` skill that consumes the `.qf/cleanup/<key>.json` payload written by `qfg cleanup remove`. Greps the current repo for call sites using the payload's SDK patterns, asks the driving engineer once which branch/variant wins, mechanically applies that direction across all call sites, runs the repo's formatter + tests, and opens one PR per repo. Handles bool, variant, and config (string/int/double/json/string-list/duration/log_level) flag types. Never auto-merges. Trigger phrases in the front matter auto-load the skill when an agent invokes any `qfg cleanup` command or encounters a `readyForCleanup` flag. (qfg-olm2.5)
- feat(info): `qfg info <key>` now prints a cleanup-workflow hint when the flag has `readyForCleanup=true`, pointing at `qfg cleanup remove <key>`. (qfg-olm2.6)
- feat(delete): `qfg delete <key>` now nudges before deleting flags with recent evals — surfaces the eval count and recommends `qfg cleanup remove` + `qfg cleanup verify` instead of going straight to delete. (qfg-olm2.7)
- docs(help): `qfg create --help` and `qfg config-schema --help` now cross-reference the cleanup workflow so agents discover `qfg cleanup` when reading docs for adjacent commands. `config-schema` reference output documents the `readyForCleanup` lifecycle field. (qfg-olm2.2)
- docs(cleanup): `cli/AGENTS.md` gains a "Retiring a flag" section and the README lists the new `qfg cleanup *` commands. (qfg-olm2.8)

## 0.0.55 - 2026-05-21

- chore(deps): dependency-only release — picks up four just-merged Dependabot bumps with no user-facing CLI behavior change. `chalk` 5.5.0 → 5.6.2 (terminal-color runtime dep) and `@oclif/plugin-help` 6.2.32 → 6.2.49 (oclif help-output runtime dep); `tsx` 4.21.0 → 4.22.0 and `oclif` 4.22.29 → 4.23.7 (build/dev-only — TypeScript runner and the oclif manifest/readme tooling). Cut so the published `@quonfig/cli` is not left sitting behind `main`. (#26, #27, #28, #30)

## 0.0.54 - 2026-05-20

- fix(push): bare-path `qfg push` now sends the workspace-HEAD optimistic lock (`expectedSha`) the server requires. Pushing from a `qfg migrate` output directory failed with `configs.push failed (HTTP 426): Your qfg CLI is older than 0.0.37 ...` even on an up-to-date CLI — the bare-path push branch never sent `expectedSha`, and the server rejects its absence as a presumed-too-old client. A migrated directory is a git repo with no origin, so `qfg push` from it always takes the bare path, which meant the migrate→push flow was broken on the happy path. The bare-path probe-clone already clones the cloud repo to compute the diff, so the CLI now uses that clone's HEAD as `expectedSha`. (qfg-nhcb)
- fix(migrate): `MIGRATION_REPORT.md` is now written to `<dir>/.qf/MIGRATION_REPORT.md` instead of the workspace root. `qfg push` mirrors every non-dotfile and the server's path allow-list rejects a root-level report (`Path not allowed by push allow-list: MIGRATION_REPORT.md`), which broke `qfg migrate --dir X` followed by `qfg push`. The report now sits beside the migrator's other bookkeeping in `.qf/`, which `qfg push` already skips; the migrate output and the `--push` success message print the new (hidden) path so the report stays discoverable. (qfg-a631)
- feat(migrate): `qfg migrate` now narrates its progress instead of running silently. It prints a plan up front (source, target directory, and dry-run / local / push mode), a step line before each slow phase (authenticating, reading environments, fetching change history), a running count while paginating large change histories, and — after a local migration — explicit next steps (review the files, read the report, then `qfg push`). A large migration previously produced no output for minutes and looked frozen.
- fix(workspace create): the "To use this workspace locally" hint now prints `qfg workspace switch <org-slug>/<workspace-slug>`. It previously printed a bare workspace slug, which `qfg workspace switch` rejects.
- fix(friction-log): the `QFG_FRICTION_LOG=true` default now writes to `~/.quonfig/friction.log` instead of `~/.qfg/friction.log`. The CLI keeps tokens, profile config, and gitea tokens in `~/.quonfig/` (see `getQuonfigConfigHome()`), but the friction log was landing in a separate `~/.qfg/` dir — so the CLI scattered its state across two home-directory dotdirs. The default now resolves through `getQuonfigConfigHome()`, which also means it honors `QUONFIG_CONFIG_HOME` like every other CLI-managed file. Custom paths via `QFG_FRICTION_LOG=<path>` are unaffected. If you have an existing `~/.qfg/friction.log`, move it to `~/.quonfig/friction.log` (or just delete it) — the CLI no longer writes there.

## 0.0.53 - 2026-05-20

- feat(qfg-38sf): new `qfg serve` command — a local HTTP server that serves a [datadir](https://docs.quonfig.com/docs/how-tos/open-source-local) to browser and React Native SDK clients. Server-side SDKs (`@quonfig/node`, `sdk-go`, `sdk-ruby`, `sdk-python`, `sdk-java`) read a datadir straight off the filesystem, but browser SDKs (`@quonfig/javascript`, `@quonfig/react`, `@quonfig/react-native`) have no filesystem and can't consume a checked-in workspace. `qfg serve` bridges that gap: it reads a datadir on disk and exposes it over the same HTTP wire protocol the browser SDKs already speak to `api-delivery` in production, so you point your SDK at `http://localhost:6580` and the existing client code works unmodified. Flags: `--datadir` (workspace directory), `--environment` (which environment to evaluate), `--port` (default `6580`), `--host` (default `127.0.0.1`), `--frontend-sdk-key` (optional `Authorization: Basic 1:<key>` gate to catch a forgotten frontend key locally), `--cors-origin` (repeatable allow-list; echoes the matching `Origin`, defaults to `*`), and `--watch` (live-reload the datadir on disk changes via `dataDirAutoReload`). Telemetry is intentionally not served — a misconfigured client posting to the telemetry endpoint gets a `404` so the mistake surfaces. See the how-to: https://docs.quonfig.com/docs/how-tos/qfg-serve.

## 0.0.52 - 2026-05-19

- fix(migrate/flagsmith, qfg-ybt9): value-less STANDARD features now emit as bool flags. Previously, when a Flagsmith STANDARD feature had no value payload — every env's `feature_state_value` was `{type: 'unicode', boolean_value: null, integer_value: null, string_value: null}`, which is Flagsmith's default for a bool-only flag — the converter inferred `valueType: 'string'` and emitted `value: ''`, silently losing the per-env `enabled` bit. 31 of 110 features (28%) in the live `Test1` project hit this shape; any Flagsmith migration done with 0.0.51 would have produced string-typed empty-string flags where the user intended bools. The fix adds an `isValuelessStandardBool` detector and an early-return in the three value-emission sites (`envDefaultRuleValue`, `identityOverrideRuleValue`, `servedValueSilent`) that serves `{type: 'bool', value: fsState.enabled}` directly. Anyone who migrated with 0.0.51 should re-run.
- chore(migrate/flagsmith): move the per-multivariate-feature "users will be re-bucketed" note emission from the source accessor (`sources/flagsmith.ts`) into the converter (`sources/flagsmith/translate.ts`), matching the LaunchDarkly precedent and plan §5.4. No user-visible change — live-corpus MIGRATION_REPORT.md is byte-identical before and after.

## 0.0.51 - 2026-05-18

- feat(migrate): `qfg migrate --from flagsmith` ships for real — the previously stubbed source is now a complete Flagsmith importer. The fetcher walks the Flagsmith Management API (project metadata, environments, features with full per-env featurestate including segment + edge-identity overrides, project segment pool, tag pool) with token auth and 429 backoff, and canonicalises the API's quirks before handing data to the converter (MV-options sort by `id` ascending so variation order matches the dashboard; per-environment identity UUIDs resolve transparently; weight orders normalise for idempotent diffing). The converter goes straight from raw Flagsmith JSON to `QuonfigFile[]` via the shared `cli/src/migrate/quonfig-target/` verb library — same pipeline as LaunchDarkly. The numeric `--project <id>` flag (or `FLAGSMITH_PROJECT_ID`) is required; Flagsmith has no default-project concept. Both write modes work: `--dir` produces a standalone local workspace git repo; `--push --workspace <slug>` clones the hosted Gitea repo, validates, and pushes. Tested against the live `Test1` project (110 features, 32 segments, 11 identities) plus a 188-fixture corpus in `cli/test/migrate/fixtures/flagsmith/{raw,expected}/`. Design: `project/plans/migrator-flagsmith.md`; user docs: `docs.quonfig.com/docs/migrating/from-flagsmith`.
- feat(migrate/flagsmith): MIGRATION_REPORT.md covers the seven Flagsmith dispositions ratified in the design plan — D-F1 enabled=false on non-boolean features (Quonfig serves stored value, not your code default), D-F2 identity > segment priority (identity overrides become a leading PROP_IS_ONE_OF rule on `user.key`), D-F3 MODULO operator (skipped), D-F4 segment-level PERCENTAGE_SPLIT (skipped, no Quonfig equivalent), D-F5 cross-env value-type divergence (coerce to string), D-F6 identity-trait references (your SDK callers must include those attributes on the eval context), D-F7 MV identity overrides (preserved — pinning and re-weighting both supported). The dedicated "users will be re-bucketed" section lists every multivariate feature (Flagsmith and Quonfig hash with different salts).
- feat(local-codegen): `qfg generate` now auto-detects a local Quonfig workspace when run inside one. Previously, with no `--dir` or `QUONFIG_DIR` set, the command minted a Gitea token and cloned the workspace from the server — which silently pulled fully-local / no-account users into `qfg login`. Now: if neither `--dir`/`QUONFIG_DIR` nor `--workspace` is set, `generate` walks up from cwd (via the same `resolveWorkspaceDir` helper `qfg push` / `qfg pull` use) looking for `quonfig.json`. If found, codegen reads the files directly with no network. The server-snapshot path is preserved as a fallback for codegen-only CI callers without a checkout; passing `--workspace` explicitly still skips the cwd walk. Surfaced while writing the open-source / fully-local docs (`docs.quonfig.com/docs/how-tos/open-source-local`).
- docs(init): `qfg init` templates no longer recommend hosted-only commands. The generated `README.md`, `CLAUDE.md`, and `AGENTS.md` now lead with the local workflow (edit JSON, `qfg verify`, `qfg generate`, commit) and explicitly tell AI agents not to call `qfg create`, `qfg set-default`, `qfg push`, `qfg pull`, `qfg get`, or `qfg list` against a local workspace — those commands require a Quonfig account. The previous README example (`qfg create my.new.flag --type=boolean-flag` + `qfg list`) was actively misleading for the no-account use case.

## 0.0.50 - 2026-05-16

- fix(qfg-0ugv): the `QFG_FRICTION_LOG=true` default now writes to `~/.qfg/friction.log` instead of `<cwd>/.qfg-friction.log`. The previous default created an untracked file inside whatever workspace clone you ran `qfg` from, which on 2026-05-15 caused a stacked `.gitignore` commit to block a config push (`.gitignore` isn't on the Gitea push allow-list, and shouldn't be — it's a customer-facing storage-format rule). Custom file paths via `QFG_FRICTION_LOG=<path>` still work (absolute paths used as-is, relative paths resolve against cwd). Parent dir is auto-created.

## 0.0.49 - 2026-05-15

- fix(qfg-wu85): `qfg migrate --dir <path>` no longer commits the migration into an ancestor git repo when the target is a subdirectory of one. Previously the `isGitRepo()` check ran `git rev-parse --git-dir`, which walks UP the filesystem — so running `qfg migrate --dir ./my-flags` from anywhere inside an existing git tree (your app repo, a monorepo) silently reused that ancestor repo for the migration commit. The actual migration files ended up loose in the target dir (often gitignored by the ancestor), while the commit landed on the ancestor with author `quonfig migrator` and swept in whatever unrelated uncommitted changes were sitting in the ancestor's working tree. Discovered by the first real LaunchDarkly migration smoke test against staging. The fix uses `git rev-parse --show-prefix`, which returns the relative path from the enclosing toplevel down to `dir` — empty string when `dir` IS the toplevel, non-empty when it's a subdir of an ancestor — sidestepping the cross-platform path-string pitfalls of comparing `--show-toplevel` against `dir` (macOS `/var/folders` ↔ `/private/var/folders` symlinks, Windows 8.3 `RUNNER~1` short names, case folding). Same fix applied to all three `isGitRepo` definitions: `cli/src/migrate/local-write.ts`, `cli/src/util/clone-and-stack-push.ts`, `cli/src/util/git-ops.ts`. Regression test in `cli/test/migrate/launchdarkly-write-modes.test.ts`.

## 0.0.48 - 2026-05-15

- feat(qfg-88cx): `qfg migrate --from launchdarkly` ships for real — the previously stubbed source is now a complete LaunchDarkly importer. Phase-1 config-snapshot fetcher walks the LD REST API (projects, environments, context kinds, flags with full per-env targeting, segments per env, optional members and AI Configs) with header auth, offset pagination, and 429 backoff against `X-Ratelimit-Reset`. The converter goes straight from raw LD JSON to `QuonfigFile[]` via a new shared `cli/src/migrate/quonfig-target/` verb library (`ruleset.ts`, `operators.ts`, `values.ts`, `report.ts`) — no provider-neutral IR; Quonfig is the IR. Both write modes inherited from the source-agnostic framework: `--dir` produces a standalone local workspace git repo; `--push --workspace <slug>` clones the hosted Gitea repo, validates, and pushes. Tested against 80 flags + 11 segments + 1 hand-authored fixture exported from the live `competitor-launchdarkly` account into `cli/test/migrate/fixtures/launchdarkly/{raw,expected}/` — 257 LaunchDarkly-specific tests passing, including converter golden tests and a convert→sdk-node-evaluate round-trip. See `project/plans/migrator-launch-darkly.md` for the full design.
- feat(qfg-88cx, D8): generalize the source API-key flag. New `--source-api-key` flag with `QUONFIG_MIGRATE_API_KEY` env, plus per-provider env fallback (`LAUNCHDARKLY_API_KEY`). Existing `--api-key` / `LAUNCH_API_KEY` kept as deprecated aliases for the `launch` source so prior commands still work.
- feat(qfg-mol-bkd): `--full-summary` Phase 2 history backfill for LaunchDarkly — resumable audit-log walker reifies per-change git commits with original author / date / message via `getCommitMeta()`. Pre-flight retention check probes the account's actual audit horizon (LD Developer plans retain only 30 days) and warns the user up-front before the slow phase starts. History is best-effort and provider-dependent: without `--full-summary`, current state only; with it, backfill whatever the source retained; if a provider can't support history, fail fast with a clear message.
- feat(qfg-mol-0iy): the `MIGRATION_REPORT.md` writer now consumes LaunchDarkly converter dispositions — skipped flags (prerequisites, individual targets converted to leading `PROP_IS_ONE_OF` rule, negated comparison/date/semver operators), dropped overrides (`privateAttributes`, experiment-rollout seed/metadata, `clientSideAvailability` mobile-key dimension), coerced sentinels — plus a dedicated "users will be re-bucketed" section listing every flag with a percentage rollout, since LaunchDarkly and Quonfig hash differently. Nothing is silently dropped.

## 0.0.47 - 2026-05-14

- chore(deps): dependency maintenance sweep — bump `zod` 4.1.12 → 4.4.3 and `acorn-walk` 8.3.4 → 8.3.5 (runtime), and `prettier` 3.6.2 → 3.8.3, `msw` 2.10.4 → 2.14.6, `@types/node` 18.19.129 → 18.19.130 (dev). All five dependabot PRs rebased onto the post-`qfg-qilt` test matrix (Windows dropped) and merged green.

## 0.0.46 - 2026-05-14

- feat(qfg-7429): `qfg push` now ships your actual local git commits to the server as a packfile, instead of shipping file deltas and letting the server fabricate a fresh commit. The commit on origin is the commit you made locally — same SHA, same message, same author. Multi-commit history is preserved (N local commits land as N commits, not squashed). A successful `qfg push` leaves your local repo genuinely in sync with origin: no more phantom "ahead by 1" / "local commits diverge" loop. Authorization is per-commit and file-level on pushes to `main`; pushes to other branches are membership-gated only. Requires app-quonfig with the `configs.gitPush` handler (live in production as of 2026-05-14).
- feat(qfg-7429.5): push denials now render per-commit attribution — which commit, which file, which permission was missing. When a forbidden change appears to have come from a non-Quonfig upstream remote, the error includes a `revert-upstream` recovery hint pointing at the offending commit.
- feat(qfg-7429.6): `qfg push` detects the legacy orphan-commit divergence state (created by older CLI versions that fabricated server-side commits) and prints a `git reset --hard origin/<branch>` migration hint instead of failing opaquely.
- feat(qfg-glrd.2): `qfg push` / `qfg pull` resolve the workspace directory from the current working directory — explicit `--dir` is no longer required when you're standing in a workspace. The error when cwd isn't a workspace is now specific.
- feat(qfg-glrd.3): the wrong-directory safety check walks all configured git remotes, not just `origin`, when matching the local checkout against the backend repo.
- fix(qfg-glrd.6): retire the `Pushed-Via` commit trailer. Server-added trailers changed the commit SHA and reintroduced divergence; the push channel is now recorded in the server-side `push_events` audit table instead.

## 0.0.45 - 2026-05-11

- fix(qfg-c3es): bump the hosted JSON Schema URL in `qfg init` templates to `https://api.quonfig.com/schemas/v1/stored-config.json`. 0.0.44 advertised an unversioned URL that didn't actually exist as a route (Next.js served the schema at `/api/schemas/...` while the templates pointed at `/schemas/...`, which 307'd to WorkOS auth on production). app-quonfig now serves the schema at the versioned, no-`/api/`-prefix path; this release aligns the workspace templates so newly-emitted `$schema` references resolve. The `/v1/` segment also gives us an immutable-`$id` escape hatch — future breaking changes ship as `/v2/...` instead of mutating in place.

## 0.0.44 - 2026-05-11

- feat(qfg-sv3c): `qfg init` no longer emits a per-workspace `quonfig.schema.json`. The README.md, CLAUDE.md, and AGENTS.md templates now reference the hosted JSON Schema at `https://api.quonfig.com/schemas/stored-config.json` (served by app-quonfig as of qfg-c3es), so every workspace gets the current schema without needing to re-run `qfg init`. Existing stale `quonfig.schema.json` files in customer repos are left untouched — explicit non-migration decision; they're harmless and the hosted URL takes precedence in `$schema` references. `src/init/schema.ts` is kept (not deleted) because `qfg config-schema --json-schema` and the operator-parity test still import `storedConfigJsonSchema()`.
- fix(schema): align the hand-curated `storedConfigJsonSchema()` with the Zod `StoredConfigSchema` source-of-truth in app-quonfig. Adds the `readyForCleanup` property (added to Zod in qfg-580q, never ported here) and renames `variant.key` → `variant.name` to match the Zod (the cli copy was stale; no workspace data references either field name). Drift surfaced by the new cross-repo drift check in qfg-svmx; the check now reports "No drift detected".

## 0.0.43 - 2026-05-10

- chore(qfg-y7xh): bump `engines.node` floor to `>=20.9.0` to align with the rest of the Quonfig SDK family (Node 20.9 is the minimum LTS that supports `fetch`, `--import`, and the global `crypto` shape we rely on).
- feat(qfg-7jnb.8): `qfg verify` accepts `IS_PRESENT` and `IS_NOT_PRESENT` operators in rule criteria. (Also shipped in 0.0.42; included here for the intentional release-commit gap that 0.0.42's tag covered.)
- fix(qfg-3fc6): `qfg push` on the clone path now picks up untracked files in the working tree instead of silently skipping anything not yet `git add`'d. The clone-path stager was using `git diff --name-only` against `HEAD`, which by definition only sees tracked files; switched to a `git status --porcelain`-based enumeration that includes `??` entries so a brand-new config file gets pushed on first try.
- ci(qfg-uzoo): the cli repo now runs `lint`, `prettier`, `build`, and `test` on every push to `main` (not just PRs) so an admin-merge through a red PR can't silently land a regression. Three "not logged in" tests were leaking the user's real `~/.quonfig/tokens.json` via process-wide env state and have been migrated to the `setupTestAuth` / `cleanupTestAuth` helpers that redirect `~/.quonfig/` to a per-test tmp dir via `QUONFIG_CONFIG_HOME`.
- fix(qfg-3uks): `qfg push --no-interactive` now aborts with a specific, actionable error when the gitea token mint step fails (e.g. expired session, missing scope) instead of silently falling back to an interactive prompt that no automation can answer. The same mint-failure path on the bare-token bootstrap now reports the underlying gitea error rather than a generic "auth failed".
- chore(cli): expand the published `package.json` `description` with a one-liner showing `qfg run` usage so the npm registry page surfaces the new env-injection workflow. Add `.beads/` to `.gitignore`.

## 0.0.42 - 2026-05-07

- feat(qfg-7jnb.8): `qfg verify` accepts `IS_PRESENT` and `IS_NOT_PRESENT` operators in rule criteria. These take only `propertyName` and intentionally have no `valueToMatch`. The verify schema's `OperatorSchema` enum, the `PROPERTY_OPERATORS` set (so missing `propertyName` is still flagged), and the Launch migrator allowlist are all extended in lockstep — the existing parity test asserts the migrator and verify enums never drift. The `qfg init` operator-reference table and `qfg config-schema` REFERENCE table both get a new presence-operator row.
- fix(qfg-7jnb.8): the `QUONFIG_SUPPORTED_OPERATORS` parity test (`test/migrate/operator-validation.test.ts`) now reads the runtime-exported `OPERATORS` tuple from `src/verify/validate.ts` instead of regex-matching an inline `z.enum([...])` literal. The regex hadn't matched since `OPERATORS` was extracted into a `const` (and `z.enum(OPERATORS)` was substituted in its place), so the lockstep guard had been silently failing on `null` — fixed and now actually enforces parity.

## 0.0.41 - 2026-05-06

- fix(qfg-84df): `qfg create … --env-var=X` and `qfg set-default … --env-var=X` no longer fail with `defaultValue.value: Invalid input: expected string, received undefined`. The CLI was emitting `{type: '<scalar>', provided: {…}}`, but the API's `ProvidedValueSchema` is a Zod discriminated union expecting `{type: 'provided', value: {source, lookup}}`. Both write paths now emit the correct shape via the shared `mapConfigValueToDto` helper. Unblocks the encryption-key bootstrap (`qfg create quonfig.secrets.encryption.key --type string --env-var=QUONFIG_ENCRYPTION_KEY`).

## 0.0.40 - 2026-05-06

- feat(qfg-4jya): new `qfg run` command wraps a child process with Quonfig values resolved into env vars — for build steps, migrations, and one-shot scripts that read config from `process.env` before user code runs (e.g. `drizzle-kit migrate`, `next-auth`'s `AUTH_SECRET`). Inline form `qfg run --env DATABASE_URL=db.url -- drizzle-kit migrate` and env-file form `qfg run --env-file=.qfg.env -- next build`. Required `--` separates qfg flags from the child command. Default behavior overrides parent env (`--preserve-env` to skip already-set vars). Fail-fast on missing keys before spawning the child. Auth/environment uses a binary mutually-exclusive rule: Mode A (`QUONFIG_BACKEND_SDK_KEY` set, env encoded in key — error if `--environment` or `QUONFIG_ENVIRONMENT` is also set, even if they would agree) or Mode B (no SDK key, requires exactly one of `--environment` or `QUONFIG_ENVIRONMENT`). Companion docs site update tracked separately (qfg-kj0e).

## 0.0.39 - 2026-05-06

- fix(qfg-57q): `qfg generate` no longer crashes with `template.match is not a function` on workspaces that contain a `weighted_values` rule. The `local-config-reader.mapGitValue` default branch was casting the weighted-values wrapper object into `valueObj.value.string`, and downstream codegen called `.match()` on the object from `MustacheExtractor`. The fix expands `weighted_values` rules into N row values (one per variant) so codegen sees real strings, drops unknown rule types instead of corrupting `value.string`, and adds defensive type guards in `MustacheExtractor.extractSchema` and `SchemaExtractor.getAllStringsAtLocation` so a future malformed row can't crash codegen. JSON-typed configs were always handled correctly via `resolveUserSchema` + `jsonSchemaToZod`; the original bug report's diagnosis ("JSON configs break codegen") was a misattribution — the actual trigger was a sibling string config with a weighted-values rule.

## 0.0.38 - 2026-05-05

- feat(qfg-d6cn): new `qfg activity` namespace surfaces audit-log / history events, with `qfg audit-log`, `qfg history`, and `qfg log` aliases pointing at the same command.
- fix(qfg-kemk): `qfg info` now passes the environment **name** (not UUID) to `evaluationStats`, fixing the empty-stats output users saw when scoping `qfg info` to a specific environment.

## 0.0.37 - 2026-05-03

- feat: `qfg push` sends `expectedSha = origin/main HEAD sha at fetch time` to the server-side `configs.push` optimistic lock (qfg-gj3i). CLI half of the atomic flip with the upcoming app-quonfig change that makes the server enforce this. Bare-path pushes (no `.git/`) omit the field entirely so the server applies its bare-path lock policy unchanged.

## 0.0.36 - 2026-05-03

- feat(qfg-0q1f): `qfg verify` accepts `PROP_SEMVER_LESS_THAN`, `PROP_SEMVER_EQUAL`, and `PROP_SEMVER_GREATER_THAN` operators in rule criteria. Schema's `OperatorSchema` extended; parity test asserts the migrator allowlist stays in lockstep.
- feat(qfg-0q1f): Launch migrator now passes `PROP_SEMVER_*` rules through to the output config instead of skipping them as unsupported. Resolves the FormHealth migration blocker on mobile-app-version-gated flags (qfg-l18w).

## 0.0.35 - 2026-05-03

- fix(qfg-7eig): `MIGRATION_REPORT.md` Counts section now reflects what was actually written to disk per type (flags, configs, segments, schemas, log-levels) instead of the source change-event count. The migrator commit message uses the same per-type summary (e.g. `migrator: imported 166 flag(s), 142 config(s), 1 segment(s) from launch`) instead of `migrator: import 5332 change(s)`.
- fix(qfg-qhk1): migrator now normalizes `/` to `.` in source keys so outputs are always flat `<type-dir>/<key>.json`. Detects post-normalization key collisions and throws `MigratorKeyCollisionError` with both colliding source keys named. Refuses to write nested paths if a translate() emits one. Cleans up empty parent dirs left over from legacy nested layouts on tombstone.
- fix(qfg-l18w): migrator validates rule operators against the Quonfig schema at migrate time. Configs whose rules use unsupported operators (e.g. `PROP_SEMVER_*`) are now per-config skipped — the offending key lands in `MIGRATION_REPORT.md`'s "Skipped invalid configs" section with the operator name(s) listed, instead of silently writing JSON that fails at qfg-verify. A parity test asserts the migrator's allowlist stays in lockstep with verify's `OperatorSchema`.
- fix(qfg-fbh0): when `qfg migrate --push` refuses to clobber a local dir whose origin doesn't match the target, the error now names the most likely cause (you ran `qfg migrate --dir` first, which `git init`'d a no-remote repo) and lists two concrete fixes (re-run with `--push` against a NEW empty path, or `qfg pull` first then re-run). Docs at https://docs.quonfig.com/docs/migrating/from-launch updated to use the proven single-command flow.

## 0.0.34 - 2026-05-03

- fix: `qfg push` refuses to run when local HEAD is behind or has diverged from origin/main. Previously the clone-path push computed `HEAD..origin/main` after fetch and shipped the _reversal_ deltas to the server, silently undoing any commits landed since the user's last `qfg pull`. Working-tree edits the user had not committed were also dropped without warning. Now throws `STALE_HEAD` with a "run `qfg pull` first" message, and warns about every dirty tracked file so the user knows their uncommitted edits were not pushed (qfg-fboj). The same guard also covers the delete-vs-edit silent-revival case (qfg-0j59).
- feat: `qfg pull --rebase` invokes `git pull --rebase origin main` to replay local commits on top of origin. Conflicts are surfaced via standard git markers with a step-by-step recovery recipe (resolve markers → `git add` → `git rebase --continue` → `qfg push`, plus `git rebase --abort` as the escape hatch) (qfg-4tey).
- fix: `qfg pull` divergence error now lists concrete recovery options (rebase vs `git reset --hard origin/main`) with the directory path filled in, instead of the previous "resolve manually" message that left non-git-savvy users stranded.

## 0.0.24 - 2026-04-28

- feat: `qfg login` now opens the WorkOS verification URL in the browser when the user presses Enter. Polling for the device-code token continues regardless, so manual paste still works exactly as before.
- style: prettier --write across the codebase — 20 files reformatted with no semantic changes.

## 0.0.23 - 2026-04-28

- feat: `qfg push` now produces a JSON diff and POSTs it to the new server-side `configs.push` oRPC procedure instead of running `git push` against Gitea with a user-held write token. Surfaces per-file permission denials and conflict→pull-and-retry hints. The bootstrap and migrate carve-outs still mint a write-PAT (qfg-azk.13).
- feat: `qfg verify` validates the renamed `access` enum (`support`, `standard`, `protected-env`, `protected-all-envs`) on configs. Drops the unused `protection` field. JSON Schema generator emits the new enum (qfg-azk.1).
- fix: test-auth-helper now redirects `~/.quonfig/` to a per-test tmp dir via a new `QUONFIG_CONFIG_HOME` env var. Previously `setupTestAuth`/`cleanupTestAuth` overwrote and unlinked the user's real `~/.quonfig/tokens.json` and `~/.quonfig/config` on every CLI test run.

## 0.0.22 - 2026-04-27

- feat: `qfg delete <key>` — server-mediated delete that resolves the key's type via `metadata.list` and dispatches to the existing flags/configs/logLevels delete oRPC endpoints. Confirmation required: `--yes` for scripts, otherwise an interactive type-back prompt; refuses to proceed when stdin is not a TTY without `--yes` (qfg-88a).
- feat: `qfg delete` threads `expectedCommitSha` from `metadata.list` and retries once on a 409 conflict by parsing the fresh SHA from the server message — matches the override pattern (qfg-o2s).
- fix: SDK-key eval path no longer defaults to the dead `api.quonfig.com` hostname. The CLI now resolves the delivery URL via a new `getDeliveryUrl()` helper that returns `QUONFIG_API_URL` if set, else `https://primary.${QUONFIG_DOMAIN || 'quonfig.com'}`. Staging users with `QUONFIG_DOMAIN=quonfig-staging.com` automatically pick up `primary.quonfig-staging.com` with no extra env var.

## 0.0.21 - 2026-04-26

- feat: `qfg override <flag> <value>` rewritten against the new oRPC `flags/findOrCreateOverride` endpoint. Previous releases pointed at the dead Prefab `/internal/ops/v1/assign-variant` endpoint and failed with `Unexpected token <` (qfg-pj0.6, qfg-pj0.1).
- feat: `qfg create --type duration` for ISO-8601 duration configs (qfg-n53).
- feat: `qfg generate` works without `--dir` by cloning the workspace into a tmp dir (qfg-0mj).
- fix: `qfg login` verifies token and config writes actually persisted before reporting success (qfg-2qj).
- fix: recover auth config from existing tokens before declaring `Not logged in` (qfg-ogr).
- fix: codegen `JSON.stringify`s object-form JSON default values; surfaces a clearer hint when `mustache` isn't installed.

## 0.0.20 - 2026-04-24

- chore: fix stale `'gen' command` string in the autogen header emitted by `qfg generate` (both node-ts and react-ts targets). The command has been named `generate` since the Reforge fork; the comment now matches.

  Note: `qfg generate --targets node-ts` output requires `@quonfig/node` **>=0.0.16**, which widens `ContextValue` to `unknown` so the generated `contexts?: Contexts | ContextObj` signatures compile.

## 0.0.11 - 2026-04-18

- fix: `qfg get` resolves `providedBy` (ENV_VAR) pointers and decrypts `decryptWith` ciphertext locally against the new raw-match response shape from `/api/v1/evaluations/evaluate` (qfg-c7d.3). Prior 0.0.10 still expected the legacy shape and silently printed nothing for confidential configs.

## 0.0.8 - 2026-04-17

- fix: `qfg get` sends the environment slug instead of the DB UUID to `/api/v1/evaluations/evaluate` (rename `environmentId` → `environmentName` on that endpoint). Fixes 500s on value evaluation.

## 0.0.6 - 2026-04-11

- feat: workspace-first login UX — picker shows all workspaces across orgs with `Organization / workspace` format
- feat: `qfg workspace switch` — switch workspace without re-authenticating
- feat: `QUONFIG_WORKSPACE=slug` env var and `--workspace` flag to pin workspace per project or per command
- feat: `qfg workspace` — shows current workspace with org name and hints for switching
- chore: `qfg profile` hidden and redirected to `qfg workspace switch` (deprecated)
- chore: `--profile` flag hidden on all commands; use `--workspace` instead

## 0.0.5 - 2026-03-31

- feat: `qfg init` — initialize or update a Quonfig workspace. Creates directory structure, managed docs (README.md, CLAUDE.md, AGENTS.md), `quonfig.schema.json`, git repo, and pre-commit hook. Idempotent — safe to re-run for updates.
  - `--samples` / `--no-samples` to control example config generation
  - `--dry-run` to preview without writing
- feat: `qfg verify` now shows detailed summary of checks performed: file counts by type, rules validated, unique keys verified, segment and schema ref integrity.
- fix: staging and production token storage separated by domain so credentials don't collide.

## 0.0.13 - 2025-12-08

- fix: string/number comparison issue

## 0.0.11 - 2025-11-24

- fix: typos in 'reforge generate --help'

## 0.0.10 - 2025-11-24

- fix: ignore Zod.describe method to not interfere with type generation

## 0.0.9 - 2025-11-20

- feat: upgrade to zod v4 + support for `meta`
- docs: encourage use of direnv when contributing

## 0.0.8 - 2025-10-29

- Added support for `ZodRecord` types in code generation mappers
- Added `-o` / `--output-directory` flag to `generate` command to specify output directory per run

## 0.0.7 - 2025-10-20

- Adds "whoami" command and optional verbose logging to debug login process [#65]
- Updated `get` command to support encrypted config values that need a local env var to decrypt [#66]

## 0.0.6 - 2025-10-13

- fix: Handle enum values that come back as a single string, not an array of strings

## 0.0.5 - 2025-10-09

- Updated `get` command to no longer prompt for an sdk key, ensured no other commands will either
- Updated `create` command to better handle creation of encrypted values

## 0.0.4 - 2025-10-09

- Adds mcp command to assist installation of quonfig's mcp in claude desktop
- Clean up logging output (especially test output)
- Improve the get command to interactively prompt for a key and confirm it exists before proceeding

## 0.0.3 - 2025-10-07

- fix: automated release process

## 0.0.2

N/A

## 0.0.1 - 2025-10-07

- feat: OAuth login with JWT authentication and v1 API migration
- feat: nodejs typegen shouldn't generate unnecessary async methods
- feat: expose the reforge client directly in nodejs typegen

## 0.0.0-pre.11 - 2025-10-01

- fix: don't assume feature flags are boolean values in typegen

## 0.0.0-pre.10 - 2025-09-30

- Type generation improvements to support javascript sdk

## 0.0.0-pre.9 - 2025-09-05

- Type generation improvements to support module augmentation

## 0.0.0-pre.8 - 2025-08-18

- Type generation support for node + react

## 0.0.0-pre.0 - 2025-08-04

- Reforge rebrand

# @prefab-cloud/prefab

All releases below were released as part of the
[@prefab-cloud/prefab-cli](https://github.com/prefab-cloud/prefab-cli) package.

## @prefab-cloud/prefab - [0.4.6](https://github.com/oclif/hello-world/compare/0.4.5...0.4.6) (2023-11-11)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 4.0.2 to 4.1.5 ([90e69e5](https://github.com/oclif/hello-world/commit/90e69e58caab0d401869a7523dbcd1387803234d))

## @prefab-cloud/prefab - [0.4.5](https://github.com/oclif/hello-world/compare/0.4.4...0.4.5) (2023-11-05)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.19 to 5.2.20 ([d710325](https://github.com/oclif/hello-world/commit/d710325af125cd0acc4cb7ee732569efa29d9e6c))

## @prefab-cloud/prefab - [0.4.4](https://github.com/oclif/hello-world/compare/0.4.3...0.4.4) (2023-10-28)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.7.0 to 3.9.4 ([8369b56](https://github.com/oclif/hello-world/commit/8369b566d0ce50909e54b477ae5bb6c11b082f3d))

## @prefab-cloud/prefab - [0.4.3](https://github.com/oclif/hello-world/compare/0.4.2...0.4.3) (2023-10-10)

### Bug Fixes

- update dev.cmd too ([2ce7bdc](https://github.com/oclif/hello-world/commit/2ce7bdc2c2b262f8f16bcab62fe7c9c5dd8d3f48))
- use node with ts-node loader ([5f406d6](https://github.com/oclif/hello-world/commit/5f406d6dd2ce06bcfe50a9c003bcfe25c63d93b4))

## @prefab-cloud/prefab - [0.4.2](https://github.com/oclif/hello-world/compare/0.4.1...0.4.2) (2023-10-09)

### Bug Fixes

- use latest eslint-config-oclif-typescript ([a010663](https://github.com/oclif/hello-world/commit/a010663092a2c269c56cecc96bfd4ff3bcb4a2f1))

## @prefab-cloud/prefab - [0.4.1](https://github.com/oclif/hello-world/compare/0.4.0...0.4.1) (2023-10-04)

### Bug Fixes

- deps ([ede92f9](https://github.com/oclif/hello-world/commit/ede92f95be182a8cd08f970781988959e02550b0))
- satisfy linter ([896fd96](https://github.com/oclif/hello-world/commit/896fd96ab5821774751811567ab7d97d01e8bb2b))

# [0.4.0](https://github.com/oclif/hello-world/compare/0.3.0...0.4.0) (2023-10-04)

### Features

- bump core, add prettier ([5be0350](https://github.com/oclif/hello-world/commit/5be0350ed4446ec1fc2eba55b73b459875f8b90b))

# [0.3.0](https://github.com/oclif/hello-world/compare/0.2.3...0.3.0) (2023-09-18)

### Features

- update eslint configs ([85c1530](https://github.com/oclif/hello-world/commit/85c15307f8faefb2646050276a58c310f48cff2b))

## @prefab-cloud/prefab - [0.2.3](https://github.com/oclif/hello-world/compare/0.2.2...0.2.3) (2023-09-17)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.4.0 to 3.7.0 ([04939c2](https://github.com/oclif/hello-world/commit/04939c21e6db4018ab8655c1f37ae3c10d85f0d1))

## @prefab-cloud/prefab - [0.2.2](https://github.com/oclif/hello-world/compare/0.2.1...0.2.2) (2023-09-16)

### Bug Fixes

- **deps:** bump @oclif/core from 3.0.0-beta.12 to 3.0.0-beta.13 ([f054f82](https://github.com/oclif/hello-world/commit/f054f823c30b6080ae005a8f9fe5dd30290ad061))

## @prefab-cloud/prefab - [0.2.1](https://github.com/oclif/hello-world/compare/0.2.0...0.2.1) (2023-09-09)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.17 to 5.2.19 ([60d2b33](https://github.com/oclif/hello-world/commit/60d2b338401d4d9a5790416c99b7cbe6c019346f))

# [0.2.0](https://github.com/oclif/hello-world/compare/0.1.6...0.2.0) (2023-09-07)

### Features

- use ts-node in bin/dev.js ([6ab5e0f](https://github.com/oclif/hello-world/commit/6ab5e0f31cb7c09c196d30bd3ecdf2f9e7462ea8))

## @prefab-cloud/prefab - [0.1.6](https://github.com/oclif/hello-world/compare/0.1.5...0.1.6) (2023-09-05)

### Bug Fixes

- remove ts-node loader ([370eba5](https://github.com/oclif/hello-world/commit/370eba5db778c240bf95fca27f5afac71aa48466))

## @prefab-cloud/prefab - [0.1.5](https://github.com/oclif/hello-world/compare/0.1.4...0.1.5) (2023-09-05)

### Bug Fixes

- update bin scripts ([9d14905](https://github.com/oclif/hello-world/commit/9d1490590a11ff79f817dd8ec8e9a548b70d9aa6))

## @prefab-cloud/prefab - [0.1.4](https://github.com/oclif/hello-world/compare/0.1.3...0.1.4) (2023-09-03)

### Bug Fixes

- **deps:** bump @oclif/core from 3.0.0-beta.6 to 3.0.0-beta.12 ([4a67b9f](https://github.com/oclif/hello-world/commit/4a67b9f67e287de7fca92376899b00cab25a2ada))

## @prefab-cloud/prefab - [0.1.3](https://github.com/oclif/hello-world/compare/0.1.2...0.1.3) (2023-09-02)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.3.2 to 3.4.0 ([d077b38](https://github.com/oclif/hello-world/commit/d077b38d54d06aefd3ffc3d78235f4a682da423b))

## @prefab-cloud/prefab - [0.1.2](https://github.com/oclif/hello-world/compare/0.1.1...0.1.2) (2023-08-31)

### Bug Fixes

- use core v3 ([0896ec1](https://github.com/oclif/hello-world/commit/0896ec15081020dd38f8cf9a26fd61f899182d29))

## @prefab-cloud/prefab - [0.1.1](https://github.com/oclif/hello-world/compare/0.1.0...0.1.1) (2023-08-23)

### Bug Fixes

- add void to bin scripts ([a3e257e](https://github.com/oclif/hello-world/commit/a3e257efa4984834d221ec356dc5269dc8c39ee9))

# [0.1.0](https://github.com/oclif/hello-world/compare/0.0.10...0.1.0) (2023-08-21)

### Features

- remove ts-node/esm shebang ([c2c3aab](https://github.com/oclif/hello-world/commit/c2c3aabcea5edf646ef87874cd4c7b87ad05c5f5))

## @prefab-cloud/prefab - [0.0.10](https://github.com/oclif/hello-world/compare/0.0.9...0.0.10) (2023-08-13)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.15 to 5.2.17 ([08b2587](https://github.com/oclif/hello-world/commit/08b25875b07788a2969393efcbb7b1d7a1bdc1dd))

## @prefab-cloud/prefab - [0.0.9](https://github.com/oclif/hello-world/compare/0.0.8...0.0.9) (2023-08-12)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.1.8 to 3.2.6 ([11e89e0](https://github.com/oclif/hello-world/commit/11e89e06d3eb1e12104bd562ff79ca2eaf0e3425))

## @prefab-cloud/prefab - [0.0.8](https://github.com/oclif/hello-world/compare/0.0.7...0.0.8) (2023-08-12)

### Bug Fixes

- **deps:** bump @oclif/core from 2.11.7 to 2.11.8 ([ff1da5a](https://github.com/oclif/hello-world/commit/ff1da5aa66ede6dc657f2ceb0c57b3a3d71fa8ba))

## @prefab-cloud/prefab - [0.0.7](https://github.com/oclif/hello-world/compare/0.0.6...0.0.7) (2023-08-10)

### Bug Fixes

- update tsconfig ([0cd7321](https://github.com/oclif/hello-world/commit/0cd73218c2a0c3fc44de072331a1b77217d06cc9))

## @prefab-cloud/prefab - [0.0.6](https://github.com/oclif/hello-world/compare/0.0.5...0.0.6) (2023-08-10)

### Bug Fixes

- bin/dev shebang ([e1633f2](https://github.com/oclif/hello-world/commit/e1633f21c04eec833747080a3da9e10b51653840))

## @prefab-cloud/prefab - [0.0.5](https://github.com/oclif/hello-world/compare/0.0.4...0.0.5) (2023-08-09)

### Bug Fixes

- bin/run shebang ([abbf92a](https://github.com/oclif/hello-world/commit/abbf92ab774077ef2e3634c6c8b679932d5f6158))

## @prefab-cloud/prefab - [0.0.4](https://github.com/oclif/hello-world/compare/0.0.3...0.0.4) (2023-08-06)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.14 to 5.2.15 ([5a25888](https://github.com/oclif/hello-world/commit/5a258889436705c8a430188343294660b0aec8af))

## @prefab-cloud/prefab - [0.0.3](https://github.com/oclif/hello-world/compare/0.0.2...0.0.3) (2023-08-03)

### Bug Fixes

- add experimentalSpecifierResolution ([a57c7e0](https://github.com/oclif/hello-world/commit/a57c7e07f2cfcc6a67d598773fe3a6ab7903c4ae))

## @prefab-cloud/prefab - [0.0.2](https://github.com/oclif/hello-world/compare/0.0.1...0.0.2) (2023-07-29)

### Bug Fixes

- **deps:** bump @oclif/core from 2.10.0 to 2.11.1 ([2a28629](https://github.com/oclif/hello-world/commit/2a286297f0e021df4ab2c3f33686b142351c70ea))

## @prefab-cloud/prefab - [0.0.1](https://github.com/oclif/hello-world/compare/27cc5bb44cc4aee53f74bfaef39c1fe03e637d72...0.0.1) (2023-07-27)

### Bug Fixes

- **deps:** bump @oclif/core from 2.9.4 to 2.10.0 ([27cc5bb](https://github.com/oclif/hello-world/commit/27cc5bb44cc4aee53f74bfaef39c1fe03e637d72))
