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

## Friction Log

Set `QFG_FRICTION_LOG=true` before running `qfg` to capture every nonzero-exit invocation as a JSON line in `.qfg-friction.log` (or pass a file path instead of `true`). Each entry has `ts`, `attempted`, `error`, and `exitCode`.

**When you finish a session that ran `qfg` with this enabled and hit any errors**, tell the human: "There are CLI gaps in `.qfg-friction.log` worth reviewing" and point them at the file. Do NOT silently paper over failed commands — surface them so the CLI can grow.

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
