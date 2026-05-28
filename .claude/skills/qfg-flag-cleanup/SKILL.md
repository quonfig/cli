---
name: qfg-flag-cleanup
description: Retire a Quonfig feature flag from a codebase — read the cleanup payload that `qfg cleanup remove` wrote, ask the engineer which branch (or variant) wins, then mechanically inline that value at every call site, delete the unreachable branches, run the repo's formatter + tests, and open one PR. Use this skill whenever the agent invokes any `qfg cleanup` command, sees a Quonfig flag marked `readyForCleanup`, or hears "retire flag", "clean up flag", "remove flag from code", "remove a feature flag", or "this flag is ready for cleanup". Handles bool, variant, and config-typed flags (string / int / double / json / string-list / duration / log_level). Never auto-merges — the engineer reviews the PR.
paths: ['**/.qf/cleanup/*.json']
---

# qfg-flag-cleanup

You are removing one feature flag from the current repository. The CLI command
`qfg cleanup remove <key>` has already done the analysis and handed you a
payload at `.qf/cleanup/<key>.json`. Your job is to translate that payload into
a single, reviewable PR.

## What `qfg cleanup remove` already did

- Confirmed the flag is marked `readyForCleanup=true` on the server.
- **Ran the telemetry safety gate.** It refused to write the payload unless
  `evals_2d == 0` (or the engineer explicitly passed `--force` because they
  know the telemetry is stale).
- Wrote the full payload — current rule shape per environment, eval sparkline
  summary, SDK grep patterns, link back to the flag URL in app-quonfig.
- Added `.qf/cleanup/` to `.gitignore` so the payload never gets committed.

You do **not** need to re-check telemetry, re-validate `readyForCleanup`, or
second-guess whether the flag is dead. That gate already ran. If you are
worried it ran wrong, the user can re-run `qfg cleanup status <key>` themselves
— don't paper over the CLI's job.

## The workflow

### 1. Read the payload

The payload lives at `.qf/cleanup/<key>.json` relative to the user's cwd. Read
it first — it tells you everything else:

```json
{
  "key": "flag.my_thing",
  "type": "bool",              // bool / variant / string / int / double / json / string-list / duration / log_level
  "flagUrl": "https://app.quonfig.com/workspaces/.../flags/flag.my_thing",
  "default": { "rules": [ ... ] },
  "environments": [ { "id": "...", "rules": [ ... ] } ],
  "evals": { "evals_4h": 0, "evals_24h": 0, "evals_2d": 0, "evals_7d": 0, "evals_30d": 0, "last_eval": null },
  "environmentSparklines": [ ... ],
  "grepPatterns": ["get", "getBoolean", "isFeatureEnabled", ...],
  "forced": false
}
```

The `type` field decides what question you'll ask in step 3 and what value
shape you'll inline in step 4. If `forced: true`, mention it in the PR body so
the reviewer knows the safety gate was bypassed.

### 2. Grep the repo for call sites

Use the `grepPatterns` array from the payload as your starting point. Each
entry is a method name the official Quonfig SDKs expose — `get`, `getBoolean`,
`isFeatureEnabled`, etc. Combine with the flag key for a precise search:

```bash
# Conceptually — use the Grep tool, not a shell pipeline.
# Pattern: any of the methods, called with the flag key as a string.
grep -rn 'isFeatureEnabled.*"flag.my_thing"' .
grep -rn 'get(.*"flag.my_thing"' .
```

Also look for language-specific wrappers the codebase may have introduced
around the SDK — e.g. a `flagEnabled("flag.my_thing")` helper, a
`<FlagGate flag="flag.my_thing">` React component, a `with_flag :flag_my_thing`
Ruby decorator. Grep the helper definition first if the key isn't called
directly, then follow it to its consumers.

If you find zero call sites, the cleanup is purely a "delete the JSON file"
operation — record that in the PR body, skip step 4, still run formatter +
tests in step 5.

### 3. Ask once: which direction does the removal go?

This is the **one question** you ask the engineer. Don't infer. The CLI on
purpose did not suggest a winning value, because only the engineer knows why
the flag was rolled out and what the new code does.

Phrase the question to match the flag `type`:

- **`bool`**: "This flag returns `true` or `false`. Keep the **true** branch
  and delete the **false** branch? Or the reverse?"
- **`variant`** / **`string`** with a documented set of variants: list the
  variants and ask "Which variant is the winner? `<a>`, `<b>`, `<c>`?"
- **`int` / `double` / `duration` / `log_level`**: list the values currently
  resolved per environment from the payload and ask "Which value wins?
  `<v1>` (production), `<v2>` (staging), or a specific value?"
- **`json` / `string-list`**: same shape — list the resolved values per env
  from the payload and ask which one wins. Paste the JSON so the engineer can
  pick by looking at it.

Ask **once**, per flag. Once you have the answer, apply it everywhere; don't
re-ask per call site.

### 4. Apply the direction mechanically

For each call site:

- **Inline the winning value.** The SDK call expression becomes the literal
  value. `client.get("flag.my_thing")` → `"on"`.
  `flags.isFeatureEnabled("flag.my_thing")` → `true`.
- **Delete the unreachable branches.** An `if (flagEnabled) { A } else { B }`
  collapses to just `A` (if true wins) or just `B` (if false wins). A switch
  statement collapses to just the winning case's body. React `<FlagGate>`
  unwraps to its children (or removes itself entirely).
- **Remove now-orphaned helpers.** If a `flagEnabled("flag.my_thing")` helper
  exists solely for this flag, delete it. If it's parameterized for many
  flags, leave it alone and just remove the call.
- **Don't touch unrelated code.** Resist the urge to refactor, rename, or
  "clean up while you're in there." Keep the diff scoped to the flag.

For non-bool flags the same shape applies — the call expression becomes the
literal value, every conditional that compared against other variants is
collapsed to either the winner's branch or removed entirely.

### 5. Run the repo's formatter and tests

Before opening the PR, run whatever the repo uses for formatting + checks.
This repo's conventions live in `.claude/rules/formatters.md` for the public
SDKs / OpenFeature providers; for customer codebases, look at:

- `package.json` scripts (`format`, `lint`, `test`, `typecheck`)
- `Makefile` or `justfile` targets
- `.pre-commit-config.yaml`
- the CI workflow at `.github/workflows/*.yml`

Run the relevant ones. If something fails, fix it (or, if the failure is
unrelated to your edit, leave a note in the PR body so the reviewer knows).

### 6. Open one PR

Scope:

- **One PR per repo.** This skill only operates on the current cwd. If the
  flag is also called from another repo, that's a separate cleanup — the
  safety gate in `qfg cleanup remove` will refuse to clear that repo until
  this PR merges and telemetry settles. Cross-repo discovery is explicitly
  out of scope.
- **One flag per PR.** Don't bundle multiple flag cleanups into one PR even
  if they happen to be ready at the same time; reviewers can decide each on
  its own.

PR body should include:

- The flag key, type, and a link to `flagUrl` from the payload.
- The direction the engineer chose ("kept the true branch, deleted false").
- A list of the call sites modified.
- A pointer back to the commit that marked `readyForCleanup=true` if you can
  find it (`git log --all -S '"readyForCleanup": true' -- <flag-json>` against
  the workspace repo — only if accessible).
- A note if `forced: true` in the payload.

**Never auto-merge.** Same posture as `qfg migrate my-code`: you open the PR,
the engineer reviews and merges. Once it merges and the SDK redeploys,
they'll run `qfg cleanup verify <key> && qfg delete <key>` to retire the
flag definition itself.

## What to do if something feels off

- **Multiple call sites disagree** — the flag is gating different behaviors
  in different places. Surface that to the engineer; they may need to split
  the cleanup or rethink the winning value.
- **The flag has a config-typed value with env-specific resolution** —
  prefer asking the engineer to pick a single value; don't try to encode the
  env split into the inlined code unless the codebase already has an
  environment switch you can land in.
- **You can't find the call sites but the SDK is loaded** — the flag may be
  called from a dynamic identifier (`client.get(flagKey)`) or from a remote
  config. Don't guess; ask.

The CLI command already filtered for safety. Your job is mechanical and
narrow: read the payload, ask the question, apply the answer, open the PR.
