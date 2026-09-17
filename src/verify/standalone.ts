/**
 * Standalone workspace validator.
 *
 * Usage:
 *   qfg-verify <workspace-dir>      Validate a workspace directory on disk
 *   qfg-verify --git-hook           Run as git pre-receive hook (reads stdin for refs,
 *                                   uses git commands to read files from the pushed commit)
 *
 * Exit codes:
 *   0  All checks pass
 *   1  Validation errors found
 */

import {execFileSync, spawnSync} from 'node:child_process'
import * as readline from 'node:readline'
import {formatResult, validateFileMap, validateWorkspace} from './validate.js'

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--git-hook')) {
    await runGitHook()
  } else if (args.includes('--help') || args.includes('-h')) {
    printUsage()
  } else {
    const dir = args[0] || '.'
    runDiskValidation(dir)
  }
}

function printUsage() {
  console.log(`qfg-verify - Quonfig workspace validator

Usage:
  qfg-verify [path]           Validate workspace directory (default: .)
  qfg-verify --git-hook       Run as git pre-receive hook
  qfg-verify --help           Show this help

Exit codes:
  0  All checks pass
  1  Validation errors found`)
}

function runDiskValidation(dir: string) {
  const result = validateWorkspace(dir)
  console.log(formatResult(result))
  process.exit(result.valid ? 0 : 1)
}

/**
 * Git pre-receive hook mode.
 *
 * Reads stdin for pushed refs (one line per ref: <old-oid> <new-oid> <ref-name>).
 * For each new commit, lists all config files and validates them.
 */
async function runGitHook() {
  const refs: RefUpdate[] = []

  // Read all of stdin (ref lines). Use callback API for bun compatibility.
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({input: process.stdin})
    rl.on('line', (line: string) => {
      const parts = line.trim().split(' ')
      if (parts.length >= 3) {
        refs.push({newOid: parts[1], oldOid: parts[0], refName: parts[2]})
      }
    })
    rl.on('close', resolve)
  })

  process.exit(runHookChecks(refs, {env: process.env, log: console.log, logErr: console.error}))
}

export type RefUpdate = {newOid: string; oldOid: string; refName: string}
export type HookEnv = Record<string, string | undefined>

export type HookOptions = {
  cwd?: string
  env: HookEnv
  log: (line: string) => void
  logErr: (line: string) => void
}

/**
 * The whole pre-receive decision, as a function: returns the process exit code
 * (0 accept, 1 reject). Split out of runGitHook so tests can drive it against
 * real bare repos without a subprocess.
 */
export function runHookChecks(refs: readonly RefUpdate[], opts: HookOptions): number {
  const {cwd, env, log, logErr} = opts

  // Always the first line, so a rollout or rollback can be confirmed by
  // something other than behaviour (plan 5.6 item 5).
  log(`qfg-verify ${hookVersion(env)}`)

  if (refs.length === 0) {
    log('qfg-verify: no refs received')
    return 0
  }

  let hasErrors = false

  // Append-only `main` (qfg-jxml.21). Runs BEFORE content validation, but does
  // not short-circuit it: an operator repair is still validated for content.
  const appendOnly = checkAppendOnlyMain(refs, env, cwd)
  if (appendOnly.bypassReason) {
    logErr(`qfg-verify: operator rewrite bypass by ${env.GITEA_PUSHER_NAME ?? '?'}: ${appendOnly.bypassReason}`)
  }

  for (const message of appendOnly.errors) {
    logErr(message)
    hasErrors = true
  }

  // Content validation: the latest pushed commit for each ref.
  for (const ref of refs) {
    // Skip deletions
    if (isZeroOid(ref.newOid)) continue

    log(`qfg-verify: validating ${ref.refName} (${ref.newOid.slice(0, 8)})`)

    try {
      const files = readFilesFromCommit(ref.newOid, cwd)
      const result = validateFileMap(files)
      log(formatResult(result))

      if (!result.valid) {
        hasErrors = true
      }
    } catch (error: unknown) {
      logErr(`qfg-verify: error reading commit ${ref.newOid}: ${(error as Error).message}`)
      hasErrors = true
    }
  }

  return hasErrors ? 1 : 0
}

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid)
}

/** The `cli` sha this binary was built from; `dev` for an unstamped build. */
export function hookVersion(env: HookEnv = process.env): string {
  return env.QFG_VERIFY_SHA?.trim() || 'dev'
}

const MAIN_REF = 'refs/heads/main'
const REWRITE_OPTION = 'quonfig-rewrite='

/**
 * `main` is append-only: every update to refs/heads/main must have a non-zero
 * old oid that is an ancestor of the new oid. A delete and a create are both
 * rejected (provisioning creates `main` with auto_init; no writer creates it by
 * push, and the zero-oid door is the only way to delete-then-recreate).
 * Other refs are untouched. See plan 2026-09-17-tree-derived-cache 5.6.
 */
export function checkAppendOnlyMain(
  refs: readonly RefUpdate[],
  env: HookEnv,
  cwd?: string,
): {bypassReason?: string; errors: string[]} {
  const mainUpdates = refs.filter((ref) => ref.refName === MAIN_REF)
  if (mainUpdates.length === 0 || !ffEnforcedForRepo(env)) return {errors: []}

  const bypassReason = operatorBypassReason(env)
  if (bypassReason) return {bypassReason, errors: []}

  const errors: string[] = []
  for (const ref of mainUpdates) {
    if (isZeroOid(ref.newOid)) {
      errors.push(rejection('deleting main is not allowed'))
    } else if (isZeroOid(ref.oldOid)) {
      errors.push(rejection('creating main by push is not allowed'))
    } else if (!isAncestor(ref.oldOid, ref.newOid, cwd)) {
      errors.push(
        rejection(`${ref.newOid.slice(0, 8)} is not a descendant of the current tip ${ref.oldOid.slice(0, 8)}`),
      )
    }
  }

  return {errors}
}

/** Rollout switch: enforce only for repos named in the allowlist; `*` = all. */
function ffEnforcedForRepo(env: HookEnv): boolean {
  const allowlist = (env.QUONFIG_HOOK_FF_ENFORCE ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (allowlist.length === 0) return false
  if (allowlist.includes('*')) return true

  // Gitea 1.25 hands the hook its repo via these (modules/repository/env.go).
  const owner = (env.GITEA_REPO_USER_NAME ?? '').trim().toLowerCase()
  const name = (env.GITEA_REPO_NAME ?? '').trim().toLowerCase()
  if (!owner || !name) return false
  return allowlist.includes(`${owner}/${name}`)
}

/**
 * Operator bypass, two keys, BOTH required: the pusher is the operator admin
 * account (the app pushes as admin too, so identity only excludes customers)
 * AND the push declares a reason with `-o quonfig-rewrite=<reason>` (which is
 * what excludes accidents). No flag-file fallback.
 */
function operatorBypassReason(env: HookEnv): string | undefined {
  const operator = (env.QUONFIG_HOOK_OPERATOR ?? '').trim()
  const pusher = (env.GITEA_PUSHER_NAME ?? '').trim()
  if (!operator || !pusher || pusher.toLowerCase() !== operator.toLowerCase()) return undefined

  const count = Number.parseInt(env.GIT_PUSH_OPTION_COUNT ?? '', 10)
  if (!Number.isInteger(count)) return undefined

  for (let index = 0; index < count; index++) {
    const option = env[`GIT_PUSH_OPTION_${index}`] ?? ''
    if (option.startsWith(REWRITE_OPTION)) {
      const reason = option.slice(REWRITE_OPTION.length).trim()
      if (reason) return reason
    }
  }

  return undefined
}

/**
 * `git merge-base --is-ancestor` via spawnSync, never simple-git: simple-git
 * swallows a non-zero exit with no stderr, so a diverged pair would RESOLVE as
 * "ancestor" and the rule would be vacuous (plan 12.2 S2). Exit 1 = not an
 * ancestor; any other non-zero is an error and the push is rejected.
 * The env is inherited as-is so Gitea's quarantine (GIT_QUARANTINE_PATH,
 * GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES) still resolves the
 * incoming objects.
 */
function isAncestor(oldOid: string, newOid: string, cwd?: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', oldOid, newOid], {cwd, encoding: 'utf8'})
  if (result.error) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`git merge-base --is-ancestor exited ${result.status}: ${(result.stderr || '').trim()}`)
}

function rejection(what: string): string {
  return `qfg-verify: REJECTED ${MAIN_REF}: ${what}.

main is append-only: every push must fast-forward from the current tip. What to do:

  * Lost a race with another writer -- pull and rebase, then push again:
      qfg pull && qfg push        (or: git pull --rebase origin main && git push origin main)

  * Want the content from an earlier commit -- restore it as a FORWARD commit:
      git restore --source=<sha> --staged --worktree -- .
      git commit -m "restore <sha>"
      qfg push

  * This came from \`qfg workspace bootstrap\` on an older CLI, which force-pushes --
    upgrade the CLI and run it again:
      npm install -g @quonfig/cli@latest`
}

/**
 * Read all JSON config files from a git commit using `git show`.
 * Works in bare repos (no working tree needed).
 *
 * qfg-6na9.6: uses execFileSync (never a shell) and `ls-tree -z` (NUL-delimited,
 * disables git's C-quoting of "unusual" paths). The old string-interpolated
 * execSync + default ls-tree output silently SKIPPED any filename containing a
 * space or non-ASCII char — exactly the Policy-A-violating keys the hook
 * exists to catch (verified live on staging: a `configs/bad charset key.json`
 * push was accepted unvalidated). A listed-but-unreadable file is now a hard
 * failure (fail closed), not a silent skip.
 *
 * qfg-hbuy.4: enumerates RECURSIVELY (`-r`) and with NO name filtering. The
 * old non-recursive listing plus `endsWith('.json') && !includes('/.')` filter
 * meant dotfiles, nested paths (configs/sub/x.json), and case-variant
 * extensions (FOO.JSON) never reached validation at all — ghost files that
 * push fine but no loader reads. The hook must see EVERYTHING under the
 * validated dirs; validateFileMap is the layer that decides what is an error.
 */
export function readFilesFromCommit(commitOid: string, cwd?: string): Map<string, string> {
  const files = new Map<string, string>()
  const dirs = ['configs', 'feature-flags', 'segments', 'log-levels', 'schemas', 'schemas-protected']

  for (const dir of dirs) {
    // List every leaf entry under this directory at the given commit. A
    // directory that doesn't exist yields an empty listing (exit 0); a
    // bad/unreadable OID throws — fail closed, the hook rejects the push.
    const listing = execFileSync('git', ['ls-tree', '-z', '-r', '--name-only', commitOid, `${dir}/`], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const filenames = listing.split('\0').filter(Boolean)
    for (const filePath of filenames) {
      // Fail closed: if a listed entry can't be read (bad object, submodule
      // gitlink, ...), the push must not be accepted with that entry
      // unvalidated — let the error propagate to the hook's per-ref handler,
      // which rejects the push.
      const content = execFileSync('git', ['show', `${commitOid}:${filePath}`], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      files.set(filePath, content)
    }
  }

  return files
}

// Only run as a program when compiled/executed as the entry point (Bun sets
// import.meta.main; under node test imports it is undefined) — this lets tests
// import readFilesFromCommit without triggering the CLI.
if ((import.meta as {main?: boolean} & ImportMeta).main) {
  main().catch((error) => {
    console.error(`qfg-verify: fatal: ${error.message}`)
    process.exit(1)
  })
}
