# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Inspecting recent changes

When asked "what changed?", "who edited X?", or "did somebody delete Y?", reach
for the activity commands instead of opening the web app. The CLI wraps the
server's audit trail directly.

```bash
# "What changed recently in this workspace?"
qfg activity feed              # newest first, default 30 entries
qfg audit-log                  # alias of `activity feed`
qfg log                        # alias of `activity feed`

# "Who edited my-flag last and when?"
qfg activity history my-flag   # full per-config commit history
qfg history my-flag            # alias
qfg audit-log my-flag          # alias (positional → history)

# "What was deleted, and can I bring it back?"
qfg activity deleted           # tombstones for unrestored deletions
qfg activity restore my-flag   # undelete (asks for confirmation)
```

All commands accept `--json` for scripting. `qfg activity feed --limit N`
caps the returned entries (1-100). Restore requires a tombstone — if the key
isn't deleted, the command exits with a clear "not currently deleted" error
rather than creating a fresh config.

## Retiring a flag

When asked "this flag is done, take it out", "clean up the X feature flag",
"retire this flag", or you spot a `readyForCleanup=true` flag, walk the
`qfg cleanup` lifecycle rather than jumping straight to `qfg delete`. The
CLI gathers signals (telemetry, current rules, resolved value) and hands
the actual code-removal work to the `qfg-flag-cleanup` Claude skill —
mirroring how `qfg migrate my-code` defers to a skill.

Full lifecycle:

```bash
# 1. Owner flips readyForCleanup=true in the UI (one-time, already exists)

# 2. "Which flags are safe to retire?"
qfg cleanup list               # candidates + 4h/24h/2d/7d/30d eval windows
qfg cleanup list --json        # structured output for agent consumption

# 3. "Drill into one flag before doing anything destructive"
qfg cleanup status my.flag     # telemetry + per-env rules + prior payloads
qfg cleanup status my.flag --json

# 4. "Start the code removal — write the payload + hand off to the skill"
qfg cleanup remove my.flag     # writes .qf/cleanup/<key>.json, prints skill hint
qfg cleanup remove my.flag --force   # bypass the evals_2d>0 safety gate

# 5. Invoke the qfg-flag-cleanup Claude skill — it reads the payload, asks
#    "which branch wins?", inlines the chosen value across call sites, runs
#    formatter + tests, and opens one PR per repo.

# 6. PR merges, SDK redeploys, telemetry drains.

# 7. "Confirm the flag is actually unused, then delete the definition"
qfg cleanup verify my.flag                   # 7-day zero-eval gate
qfg cleanup verify my.flag --days 14         # stricter window
qfg cleanup verify my.flag && qfg delete my.flag   # chain once green
```

Key rules:

- `cleanup list` and `cleanup status` are pure-read; safe to run any time.
- `cleanup remove` writes a payload only — it never edits source files. The
  qfg-flag-cleanup skill owns the code edits and opens the PR.
- `cleanup remove` refuses if the flag had any evals in the last 2 days
  unless you pass `--force`. The 2-day window absorbs SDK flush latency.
- `cleanup verify` uses a stricter trailing-7-day window than `remove` on
  purpose: `delete` permanently removes the flag definition, so we want a
  longer quiet period before chaining. Bump `--days N` for a more
  conservative gate.
- The payload at `.qf/cleanup/<key>.json` is gitignored — same convention
  as `qfg migrate my-code`'s `.qf/identifier-map.json`. Don't commit it.
- After a single-repo cleanup PR merges, re-run `qfg cleanup verify` before
  `qfg delete`. Lingering evals point at another repo that still calls the
  flag — telemetry is the cross-repo safety net.

## Friction Log

Set `QFG_FRICTION_LOG=true` before running `qfg` to capture every nonzero-exit invocation as a JSON line in `~/.quonfig/friction.log` (or pass a file path instead of `true` — relative paths resolve against the cwd). Each entry has `ts`, `attempted`, `error`, and `exitCode`.

The log lives outside the workspace clone on purpose so it doesn't show up as an untracked file in customer config repos.

**When you finish a session that ran `qfg` with this enabled and hit any errors**, tell the human: "There are CLI gaps in `~/.quonfig/friction.log` worth reviewing" and point them at the file. Do NOT silently paper over failed commands — surface them so the CLI can grow.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
