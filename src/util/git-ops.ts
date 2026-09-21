import {execFile as execFileCb, execFileSync, spawn} from 'node:child_process'
import * as util from 'node:util'

const execFile = util.promisify(execFileCb)

/**
 * Args prepended to every git invocation. Empty `credential.helper` resets the
 * helper chain for this child process only — prevents macOS git's osxkeychain
 * helper from popping a "Keychain Not Found" dialog when qfg-managed creds are
 * embedded in the URL.
 */
export const GIT_SAFE_ARGS: readonly string[] = ['-c', 'credential.helper=']

/**
 * Env additions for every git invocation. Suppress tty prompts and Git
 * Credential Manager interactive flows.
 */
export const GIT_SAFE_ENV: Readonly<NodeJS.ProcessEnv> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
}

/**
 * Redact a token from a URL string so it is safe to display to users.
 */
export const redactToken = (url: string): string => url.replace(/:([^/@]+)@/, ':***@')

export interface RunGitOptions {
  cwd?: string
  /** Extra env vars merged on top of `process.env` and `GIT_SAFE_ENV`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Canonical entry point for shelling out to git from the CLI. Always prepends
 * `GIT_SAFE_ARGS` and merges `GIT_SAFE_ENV` so credential prompts never leak
 * to the user. Errors are re-thrown with tokens redacted from message/stderr.
 */
export const runGit = async (args: string[], options?: RunGitOptions): Promise<{stdout: string; stderr: string}> => {
  const env = {...process.env, ...GIT_SAFE_ENV, ...options?.env}
  try {
    return await execFile('git', [...GIT_SAFE_ARGS, ...args], {cwd: options?.cwd, env})
  } catch (error: unknown) {
    const e = error as {stdout?: string; stderr?: string; cmd?: string} & Error
    const message = redactToken(e.message || String(error))
    const stderr = redactToken(e.stderr ?? '')
    const safeErr = new Error(message) as {stderr?: string} & Error
    safeErr.stderr = stderr
    throw safeErr
  }
}

export interface SpawnGitOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** If set, written to the child's stdin and then stdin is closed. */
  stdin?: string
}

/**
 * Spawn-based git invocation for cases where stdin needs to be piped (e.g.
 * `git commit -F -`). Same safe-args/env injection as `runGit`.
 */
export const spawnGit = (args: string[], options?: SpawnGitOptions): Promise<void> =>
  new Promise((resolve, reject) => {
    const env = {...process.env, ...GIT_SAFE_ENV, ...options?.env}
    const child = spawn('git', [...GIT_SAFE_ARGS, ...args], {cwd: options?.cwd, env})
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git ${args[0] ?? ''} exited ${code}: ${redactToken(stderr)}`))
    })
    if (options?.stdin !== undefined) child.stdin.end(options.stdin)
  })

export const gitClone = async (repoUrl: string, dir: string): Promise<void> => {
  await runGit(['clone', repoUrl, dir])
}

/**
 * True only when `dir` is itself the root of a git repo. Uses `--show-prefix`
 * (relative path from enclosing toplevel down to `dir`, empty when `dir` IS
 * the toplevel) to avoid cross-platform path-string pitfalls — see the
 * matching comment in cli/src/migrate/local-write.ts (qfg-wu85).
 */
export const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-parse', '--show-prefix'])
    return stdout.trim() === ''
  } catch {
    return false
  }
}

export const getRemoteUrl = async (dir: string): Promise<string | null> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Return every configured remote URL (one per remote name). Walks the
 * output of `git remote` and resolves each name's URL via `remote get-url`.
 *
 * Returns an empty array when the dir isn't a git repo or has no remotes.
 * Multi-remote support (qfg-glrd.3): the identity check accepts as long as
 * any configured remote points at the backend's repo URL.
 */
export const getAllRemoteUrls = async (dir: string): Promise<string[]> => {
  let names: string[]
  try {
    const {stdout} = await runGit(['-C', dir, 'remote'])
    names = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }

  const urls: string[] = []
  for (const name of names) {
    try {
      // Sequential by design: each `git remote get-url` spawns its own git
      // process against the same repo; running them serially keeps git's
      // index/lock access predictable and the remote count is tiny.
      // eslint-disable-next-line no-await-in-loop
      const {stdout} = await runGit(['-C', dir, 'remote', 'get-url', name])
      const url = stdout.trim()
      if (url.length > 0) urls.push(url)
    } catch {
      /* skip remotes whose URL we can't read */
    }
  }
  return urls
}

export const isWorkingTreeClean = async (dir: string): Promise<boolean> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain'])
  return stdout.trim() === ''
}

/**
 * Returns true if `file` (relative to `dir`) has any working-tree or
 * staged change, false if its tracked content matches HEAD.
 */
export const hasFileChanges = async (dir: string, file: string): Promise<boolean> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain', '--', file])
  return stdout.trim() !== ''
}

/**
 * Returns the list of tracked files (relative paths) with working-tree
 * or staged modifications. Untracked files (`??`) are excluded — they
 * are not considered "dirty" by callers that want to know whether the
 * user has work-in-progress that should not be swept into a commit.
 */
export const dirtyTrackedFiles = async (dir: string): Promise<string[]> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain'])
  return stdout
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.startsWith('??'))
    .map((line) => line.slice(3).trim())
}

/**
 * Stage and commit a single file with the given message. The path argument
 * to `git commit` ensures only this file is committed even if other files
 * are already staged in the index.
 *
 * Returns true if a commit was created, false if there was nothing to
 * commit (file matches HEAD already). Throws on real git errors.
 */
export const addAndCommitFile = async (dir: string, file: string, message: string): Promise<boolean> => {
  if (!(await hasFileChanges(dir, file))) return false
  await runGit(['-C', dir, 'add', '--', file])
  await runGit(['-C', dir, 'commit', '-m', message, '--', file])
  return true
}

/**
 * Read the contents of `file` (relative to `dir`) at HEAD. Returns
 * `undefined` if the file does not exist at HEAD or if HEAD itself is
 * unset (empty repo).
 */
export const readFileAtHead = async (dir: string, file: string): Promise<string | undefined> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'show', `HEAD:${file}`])
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Result of `commitPinFixIfPinOnly`. Tells callers whether a commit was
 * made and, if not, why — useful for verbose logging without throwing on
 * the migration path.
 */
export type PinFixResult = {kind: 'committed'; slug: string} | {kind: 'clean'} | {kind: 'skipped'; reason: string}

/**
 * Migration helper for legacy state where `qfg pull` wrote the workspace
 * pin to the working tree but never committed it (qfg-0fn). If
 * `quonfig.json` is dirty AND its only diff vs HEAD is an added or
 * changed `workspace` key matching `expectedSlug`, stage and commit the
 * file so push's HEAD-vs-origin delta picks it up.
 *
 * Skips (returns `kind: 'skipped'`) when the dirty file has any other
 * changes, when the pin doesn't match the backend slug, or when JSON
 * parsing fails — leaving the user's working tree alone.
 */
export const commitPinFixIfPinOnly = async (dir: string, file: string, expectedSlug: string): Promise<PinFixResult> => {
  if (!(await hasFileChanges(dir, file))) return {kind: 'clean'}

  let workingTreeRaw: string
  try {
    const {readFile} = await import('node:fs/promises')
    const {join} = await import('node:path')
    workingTreeRaw = await readFile(join(dir, file), 'utf8')
  } catch {
    return {kind: 'skipped', reason: 'could not read working-tree file'}
  }

  const headRaw = await readFileAtHead(dir, file)

  let workingParsed: Record<string, unknown>
  try {
    workingParsed = JSON.parse(workingTreeRaw) as Record<string, unknown>
  } catch {
    return {kind: 'skipped', reason: 'working-tree file is not valid JSON'}
  }

  if (typeof workingParsed.workspace !== 'string' || workingParsed.workspace !== expectedSlug) {
    return {kind: 'skipped', reason: 'working-tree workspace pin does not match backend slug'}
  }

  let headParsed: Record<string, unknown> = {}
  if (headRaw !== undefined) {
    try {
      headParsed = JSON.parse(headRaw) as Record<string, unknown>
    } catch {
      return {kind: 'skipped', reason: 'HEAD file is not valid JSON'}
    }
  }

  // Compare working tree vs HEAD ignoring `workspace`. If anything else
  // differs, the user has additional uncommitted edits — leave alone.
  const stripped = (o: Record<string, unknown>): Record<string, unknown> => {
    const rest = {...o}
    delete rest.workspace
    return rest
  }
  const a = JSON.stringify(stripped(workingParsed), Object.keys(stripped(workingParsed)).sort())
  const b = JSON.stringify(stripped(headParsed), Object.keys(stripped(headParsed)).sort())
  if (a !== b) {
    return {kind: 'skipped', reason: 'working-tree file has changes beyond the workspace pin'}
  }

  await runGit(['-C', dir, 'add', '--', file])
  await runGit(['-C', dir, 'commit', '-m', `qfg: pin workspace = ${expectedSlug}`, '--', file])
  return {kind: 'committed', slug: expectedSlug}
}

export const gitFetch = async (dir: string): Promise<void> => {
  await runGit(['-C', dir, 'fetch', 'origin'])
}

/**
 * Returns true if origin/main has commits that can be fast-forwarded into the local branch.
 */
export const canFastForward = async (dir: string): Promise<boolean> => {
  try {
    // Get the local HEAD and origin/main SHAs
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])

    const local = localSha.trim()
    const remote = remoteSha.trim()

    if (local === remote) return false // already up to date

    // Check if local is an ancestor of remote (i.e. ff is possible)
    try {
      await runGit(['-C', dir, 'merge-base', '--is-ancestor', local, remote])
      return true // exit code 0 means local is an ancestor of remote
    } catch {
      return false // local has diverged
    }
  } catch {
    return false
  }
}

/**
 * Returns true iff origin/main is NOT an ancestor of the local HEAD —
 * covering both "local strictly behind" and "diverged" in one boolean.
 *
 * Used by the clone-path stale-HEAD guard in `qfg push` (qfg-fboj):
 * either of those two states would otherwise produce a `HEAD..origin/main`
 * diff that ships REVERSAL deltas to the server, silently undoing
 * remote-newer commits. Both must refuse.
 *
 * Returns false on any git failure (no `origin/main` ref yet, no `.git/`,
 * etc.) so the caller falls through to its other guards rather than
 * aborting on an opaque error.
 */
export const isLocalBehindOrDivergedFromRemote = async (dir: string): Promise<boolean> => {
  try {
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])
    const local = localSha.trim()
    const remote = remoteSha.trim()
    if (local === remote) return false
    try {
      // exit 0 → remote is an ancestor of local → local is strictly ahead, fine.
      await runGit(['-C', dir, 'merge-base', '--is-ancestor', remote, local])
      return false
    } catch {
      // non-zero exit → remote is NOT an ancestor → behind or diverged.
      return true
    }
  } catch {
    return false
  }
}

/**
 * Returns true if local has commits not reachable from origin/main (diverged).
 */
export const hasDivergedFromRemote = async (dir: string): Promise<boolean> => {
  try {
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])

    const local = localSha.trim()
    const remote = remoteSha.trim()

    if (local === remote) return false

    // If remote is an ancestor of local, local is ahead (diverged for our purposes)
    try {
      await runGit(['-C', dir, 'merge-base', '--is-ancestor', remote, local])
      return true
    } catch {
      // Check if truly diverged (neither is ancestor of the other)
      try {
        await runGit(['-C', dir, 'merge-base', '--is-ancestor', local, remote])
        return false // ff possible, not diverged
      } catch {
        return true // truly diverged
      }
    }
  } catch {
    return false
  }
}

/**
 * Performs a fast-forward-only merge of origin/main. Returns list of new commit subjects.
 */
export const gitMergeFfOnly = async (dir: string): Promise<string[]> => {
  // Get commits that will be merged (before merge)
  let newCommits: string[] = []
  try {
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: log} = await runGit(['-C', dir, 'log', '--pretty=format:%s', `${localSha.trim()}..origin/main`])
    newCommits = log
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    // Non-fatal — we'll still attempt the merge
  }

  await runGit(['-C', dir, 'merge', '--ff-only', 'origin/main'])
  return newCommits
}

/**
 * Adds or updates the origin remote for a repo.
 */
export const gitSetRemote = async (dir: string, url: string): Promise<void> => {
  const existing = await getRemoteUrl(dir)
  if (existing === null) {
    await runGit(['-C', dir, 'remote', 'add', 'origin', url])
  } else {
    await runGit(['-C', dir, 'remote', 'set-url', 'origin', url])
  }
}

const revParse = async (dir: string, rev: string): Promise<null | string> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-parse', '--verify', '--quiet', rev])
    return stdout.trim() || null
  } catch {
    return null
  }
}

const treePaths = async (dir: string, rev: string): Promise<string[]> => {
  const {stdout} = await runGit(['-C', dir, 'ls-tree', '-r', '--name-only', rev])
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

const countCommits = async (dir: string, rev: string): Promise<number> => {
  const {stdout} = await runGit(['-C', dir, 'rev-list', '--count', rev])
  return Number.parseInt(stdout.trim(), 10) || 0
}

/**
 * Every file the validator owns at `ref` — config documents (`configs/`,
 * `feature-flags/`, `segments/`, `log-levels/`) AND schemas (`schemas/`,
 * `schemas-protected/`) — sorted.
 *
 * A workspace repo is FRESH exactly when this list is empty. It is NOT "the
 * remote holds only the auto-init commit": provisioning commits `README.md`
 * AND `quonfig.json`, so a commit-count test refuses every real workspace
 * (plan project/plans/2026-09-17-tree-derived-cache.md 5.6, 13.2 risk 5).
 * Schemas count because a UI-authored schema is content a local-wins rebase
 * would silently overwrite, exactly like a flag.
 *
 * FAILS CLOSED: if the ref cannot be listed this throws. "I could not look"
 * must never read as "the workspace is empty".
 */
export const workspaceDocumentsAtRef = async (dir: string, ref: string): Promise<string[]> => {
  // Dynamic import: `src/verify/` is copied on its own into the standalone
  // pre-receive-hook build, so it must stay self-contained — and pulling the
  // validator in statically would load it for every command that touches git.
  const {KNOWN_DIRS} = await import('../verify/validate.js')
  const paths = await treePaths(dir, ref)
  return paths.filter((p) => KNOWN_DIRS.has(p.split('/')[0])).sort()
}

export interface RebaseOntoOriginResult {
  /** How many of the customer's commits were replayed onto the remote head. */
  commitsRebased: number
  /** The sha now at `origin/main`. */
  pushedSha: string
  /** Subject of the extra commit that put the tree right, or null if none was needed. */
  reconcileSubject: null | string
}

/** Subject of the one commit that puts the tree back to the customer's. */
const RECONCILE_SUBJECT = 'reconcile merge resolutions'

/** Subject when the only thing put back is the workspace's own pin file. */
const PIN_SUBJECT = "use the hosted workspace's quonfig.json"

/**
 * `-c` args that keep the CUSTOMER's git config out of the commits bootstrap
 * makes in the temporary worktree. A worktree shares the repo's config, so
 * `commit.gpgsign=true` with an unusable `gpg.program` fails the rebase and a
 * failing `pre-commit` under `core.hooksPath` fails the reconcile commit (both
 * verified). Neither commit is the customer's to sign or to gate: the rebase
 * replays commits they already made, and the reconcile commit only restores
 * their own tree.
 */
const GIT_UNCONFIGURED_ARGS: readonly string[] = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'rebase.autosquash=false',
  '-c',
  'rerere.enabled=false',
]

/**
 * The identity the CLI commits as when nothing better is known: `qfg push`
 * and `qfg migrate` stack their commits under it, and bootstrap's replayed
 * commits get it as COMMITTER when the machine has no git identity at all.
 */
export const MIGRATOR_IDENTITY = {
  name: 'quonfig migrator',
  email: 'migrator@quonfig.com',
} as const

/**
 * Env that gives git a committer when it cannot find one itself, and nothing
 * otherwise. A rebase writes a committer on every replayed commit, and git
 * refuses ("empty ident name ... not allowed") on a machine with no
 * `user.name` / `user.email` and no guessable one — every GitHub runner, and
 * a fresh laptop. `git var GIT_COMMITTER_IDENT` is git's own check, so a
 * customer whose identity works keeps it, guessed or configured.
 */
const committerFallbackEnv = async (dir: string): Promise<Record<string, string>> => {
  try {
    await runGit(['-C', dir, 'var', 'GIT_COMMITTER_IDENT'])
    return {}
  } catch {
    return {
      GIT_AUTHOR_EMAIL: MIGRATOR_IDENTITY.email,
      GIT_AUTHOR_NAME: MIGRATOR_IDENTITY.name,
      GIT_COMMITTER_EMAIL: MIGRATOR_IDENTITY.email,
      GIT_COMMITTER_NAME: MIGRATOR_IDENTITY.name,
    }
  }
}

/**
 * How `candidate`'s tree differs from the customer's tip in ways bootstrap
 * must not ship. Nothing set means the candidate carries exactly the
 * customer's content plus the files the workspace seeded.
 */
interface TreeMismatch {
  /** Paths where the candidate would ship content the customer does not have. */
  content: string[]
  /** The candidate carries a local `quonfig.json` instead of the workspace's own. */
  pinLost: boolean
}

const hasMismatch = (m: TreeMismatch): boolean => m.pinLost || m.content.length > 0

const describeMismatch = (m: TreeMismatch): string =>
  [...m.content, ...(m.pinLost ? ["quonfig.json (the workspace's pin was lost)"] : [])].join(', ')

const treeMismatch = async (
  dir: string,
  opts: {candidate: string; local: string; remoteQuonfigJson: null | string; seededOnly: Set<string>},
): Promise<TreeMismatch> => {
  const {stdout} = await runGit(['-C', dir, 'diff', '--no-renames', '--name-status', opts.local, opts.candidate])
  const content: string[] = []
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t')
    const file = rest.join('\t')
    // A file only the workspace had is expected to appear.
    if (status === 'A' && opts.seededOnly.has(file)) continue
    // The workspace's own quonfig.json wins over a local one: it is the pin
    // that names the hosted workspace. Checked separately, below.
    if (file === 'quonfig.json' && opts.remoteQuonfigJson !== null) continue
    content.push(`${status} ${file}`)
  }

  let pinLost = false
  if (opts.remoteQuonfigJson !== null) {
    const candidatePin = await revParse(dir, `${opts.candidate}:quonfig.json`)
    pinLost = candidatePin !== opts.remoteQuonfigJson
  }

  return {content, pinLost}
}

const removeWorktree = async (dir: string, worktree: string): Promise<void> => {
  try {
    await runGit(['-C', dir, 'worktree', 'remove', '--force', worktree])
  } catch {
    /* already gone, or never created */
  }

  try {
    await runGit(['-C', dir, 'worktree', 'prune'])
  } catch {
    /* best effort */
  }
}

/**
 * Run the workspace validator — the same one the server's pre-receive hook
 * runs — over a checked-out tree, and throw with its errors if it would be
 * rejected.
 */
const requireWorkspaceValidates = async (tree: string): Promise<void> => {
  const {validateWorkspace} = await import('../verify/validate.js')
  const errors = validateWorkspace(tree).issues.filter((i) => i.severity === 'error')
  if (errors.length === 0) return

  const shown = errors.slice(0, 10).map((i) => `  ${i.file}: ${i.message}`)
  if (errors.length > shown.length) shown.push(`  ...and ${errors.length - shown.length} more`)
  const envHint = errors.some((i) => i.message.includes('not declared in quonfig.json'))
    ? "\nThe workspace's own quonfig.json replaces yours, so an environment that exists only in your local file is not declared on the workspace. Create it in the Quonfig app (or drop the override), then run bootstrap again."
    : ''

  throw new Error(
    `Refusing to push: the workspace would reject this content.\n${shown.join('\n')}${envHint}\nNothing was pushed and your local repository is unchanged.`,
  )
}

/**
 * Land the local repo's history on `origin/main` WITHOUT ever force-pushing
 * (plan 5.6 "Bootstrap keeps its history without force"; `main` is
 * append-only, so a rewrite is not just forbidden, it silently wedges config
 * delivery).
 *
 * `git fetch origin` is the caller's job. Then:
 *
 *   1. Replay the whole local history onto the remote head on a TEMPORARY
 *      worktree — never on the customer's branch. Whatever happens, their
 *      local refs and working tree are untouched.
 *   2. Require the replayed tip's tree to equal the local tip's tree, ignoring
 *      files the workspace seeded that the local repo does not have. Rebasing
 *      linearises merges and `-X theirs` silently picks a side, so a
 *      hand-resolved merge conflict can otherwise ship the wrong content with
 *      exit 0 (13.2 risk 4).
 *   3. If it differs, add ONE commit that sets the tree to the local tip's
 *      tree, keeping the seeded files and the workspace's `quonfig.json`. If
 *      that cannot be done cleanly, abort with nothing pushed.
 *   4. Validate the tree that is ACTUALLY about to be pushed (unless
 *      `validate: false`), so content the workspace would reject fails here
 *      instead of at the server hook.
 *   5. Plain `git push` of the result to `main`.
 */
export const rebaseOntoOriginAndPush = async (
  dir: string,
  opts?: {validate?: boolean},
): Promise<RebaseOntoOriginResult> => {
  const localHead = await revParse(dir, 'HEAD')
  if (localHead === null) throw new Error('The local repository has no commits to push.')

  const remoteHead = await revParse(dir, 'origin/main')
  if (remoteHead === null) {
    // Provisioning always creates `main` with auto_init, and the pre-receive
    // hook rejects a zero-oid create (plan 5.6 item 1), so pushing the branch
    // into existence is a dead end, not a fallback.
    throw new Error(
      'The workspace repository is not provisioned (it has no `main` branch).\nFinish creating the workspace in the Quonfig app, then run bootstrap again.',
    )
  }

  const remotePaths = await treePaths(dir, remoteHead)
  const localPaths = new Set(await treePaths(dir, localHead))
  const seededOnly = new Set(remotePaths.filter((p) => !localPaths.has(p)))
  const remoteQuonfigJson = remotePaths.includes('quonfig.json')
    ? await revParse(dir, `${remoteHead}:quonfig.json`)
    : null

  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const worktree = join(tmpdir(), `qfg-bootstrap-${process.pid}-${Date.now()}`)
  // The rebase keeps each commit's AUTHOR; this only decides the committer
  // (and the author of the reconcile commit, which is the CLI's own).
  const identityEnv = await committerFallbackEnv(dir)

  // Ctrl-C between `worktree add` and the `finally` would leave the temp
  // worktree registered in the customer's repo; drop it synchronously.
  const onInterrupt = (): void => {
    try {
      execFileSync('git', [...GIT_SAFE_ARGS, '-C', dir, 'worktree', 'remove', '--force', worktree], {stdio: 'ignore'})
    } catch {
      /* best effort — `git worktree prune` also clears it later */
    }

    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
    process.exit(130)
  }

  process.once('SIGINT', onInterrupt)

  try {
    await runGit(['-C', dir, 'worktree', 'add', '--detach', worktree, localHead])

    try {
      await runGit(
        [
          '-C',
          worktree,
          ...GIT_UNCONFIGURED_ARGS,
          'rebase',
          '--root',
          '--onto',
          remoteHead,
          '-X',
          'theirs',
          '--committer-date-is-author-date',
        ],
        {env: identityEnv},
      )
    } catch (error: unknown) {
      try {
        await runGit(['-C', worktree, 'rebase', '--abort'])
      } catch {
        /* nothing to abort */
      }

      throw new Error(
        [
          'Could not replay your history onto the workspace repository.',
          'Nothing was pushed and your local repository is unchanged.',
          '',
          'To land the files you have now WITHOUT their history, run:',
          `  qfg push --dir ${dir}`,
          '',
          String(error),
        ].join('\n'),
      )
    }

    let candidate = await revParse(worktree, 'HEAD')
    if (candidate === null) throw new Error('The rebase produced no commit. Nothing was pushed.')

    let reconcileSubject: null | string = null
    let mismatch = await treeMismatch(dir, {candidate, local: localHead, remoteQuonfigJson, seededOnly})
    if (hasMismatch(mismatch)) {
      // Honest subject: when the ONLY thing being put back is the workspace's
      // own pin file, nothing was "reconciled" and saying so would be a lie.
      reconcileSubject = mismatch.content.length > 0 ? RECONCILE_SUBJECT : PIN_SUBJECT
      const body =
        reconcileSubject === RECONCILE_SUBJECT
          ? 'Sets the tree to the state of the local repository, keeping the files this workspace already had. Replaying merge commits one by one can otherwise resolve a conflict differently than you did.'
          : 'The hosted workspace seeds its own quonfig.json, which carries the workspace pin and its environment list, so it wins over the one in the local repository.'
      const keepFromRemote = [...seededOnly]
      if (remoteQuonfigJson !== null && !seededOnly.has('quonfig.json')) keepFromRemote.push('quonfig.json')

      try {
        await runGit(['-C', worktree, 'restore', `--source=${localHead}`, '--staged', '--worktree', '--', '.'])
        if (keepFromRemote.length > 0) {
          await runGit([
            '-C',
            worktree,
            'restore',
            `--source=${remoteHead}`,
            '--staged',
            '--worktree',
            '--',
            ...keepFromRemote,
          ])
        }

        await runGit(
          ['-C', worktree, ...GIT_UNCONFIGURED_ARGS, 'commit', '--no-verify', '-m', reconcileSubject, '-m', body],
          {env: identityEnv},
        )
      } catch (error: unknown) {
        throw new Error(
          `Could not reconcile your local content with the workspace repository: ${String(error)}\nNothing was pushed and your local repository is unchanged.`,
        )
      }

      candidate = await revParse(worktree, 'HEAD')
      if (candidate === null) throw new Error('The reconcile commit produced no commit. Nothing was pushed.')
      mismatch = await treeMismatch(dir, {candidate, local: localHead, remoteQuonfigJson, seededOnly})
      if (hasMismatch(mismatch)) {
        throw new Error(
          `Refusing to push: the result would not match your local files (${describeMismatch(mismatch)}).\nNothing was pushed and your local repository is unchanged.`,
        )
      }
    }

    // Validate what is ACTUALLY going to be pushed. The worktree holds exactly
    // the candidate's tree, which is the local content plus the workspace's own
    // quonfig.json — so an environment that exists only in the local pin file
    // fails HERE, with a readable message, instead of at the server hook.
    if (opts?.validate !== false) await requireWorkspaceValidates(worktree)

    await runGit(['-C', dir, 'push', 'origin', `${candidate}:refs/heads/main`])
    return {commitsRebased: await countCommits(dir, localHead), pushedSha: candidate, reconcileSubject}
  } finally {
    process.off('SIGINT', onInterrupt)
    await removeWorktree(dir, worktree)
  }
}

export const hasAtLeastOneCommit = async (dir: string): Promise<boolean> => {
  try {
    await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * Get the URL stripped of credentials for display purposes.
 */
export const displayUrl = (url: string): string => redactToken(url)

/**
 * Outcome of `gitPullRebase`. Three branches the caller MUST distinguish
 * — silent failure here is what made qfg-4tey a P1 (qfg pull exit 0 with
 * no recovery path).
 */
export type GitPullRebaseResult =
  | {kind: 'clean'; commitsRebased: number}
  | {kind: 'conflicts'; conflictedFiles: string[]}
  | {kind: 'failed'; reason: string}

/**
 * `git pull --rebase origin main`. Replays local commits on top of the
 * remote tip. On conflicts, leaves the repo in rebase-in-progress state
 * with `<<<<<<<` / `=======` / `>>>>>>>` markers planted by git so the
 * user can resolve via standard git tools (`git rebase --continue` /
 * `git rebase --abort`).
 *
 * Caller is responsible for surfacing recovery instructions; this function
 * only reports the outcome.
 */
export const gitPullRebase = async (dir: string): Promise<GitPullRebaseResult> => {
  // Count local-only commits BEFORE the rebase so the success path can
  // tell the user how many got moved. After a clean rebase, origin/main
  // is the merge-base and ahead-count == commits-rebased.
  let commitsRebased = 0
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-list', '--count', 'origin/main..HEAD'])
    commitsRebased = Number.parseInt(stdout.trim(), 10) || 0
  } catch {
    // Non-fatal — counting is for UX, not correctness.
  }

  try {
    await runGit(['-C', dir, 'pull', '--rebase', 'origin', 'main'])
    return {kind: 'clean', commitsRebased}
  } catch (error: unknown) {
    // Distinguish "rebase paused on conflicts" from "rebase never started".
    // Conflicts: `diff --diff-filter=U` lists the unmerged paths and
    // `.git/rebase-merge/` is present.
    try {
      const {stdout} = await runGit(['-C', dir, 'diff', '--name-only', '--diff-filter=U'])
      const conflictedFiles = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      if (conflictedFiles.length > 0) {
        return {kind: 'conflicts', conflictedFiles}
      }
    } catch {
      // Fall through to 'failed' — diff itself errored.
    }

    const reason = error instanceof Error ? error.message : String(error)
    return {kind: 'failed', reason}
  }
}

/**
 * Returns the local SHA of `origin/main` (i.e. the remote tip we last
 * fetched), or undefined if the repo has no `origin/main` ref.
 *
 * Used as the `expectedSha` passed to the server-side `configs.push`
 * optimistic lock (qfg-gj3i): the server compares the value we send
 * against the current Gitea workspace HEAD and rejects the push if
 * origin advanced between fetch and push. Belt-and-suspenders next to
 * the CLI-side stale-HEAD guard from qfg-fboj — closes the gap for
 * non-CLI clients and CLI regressions.
 *
 * Returns undefined on bare-path pushes (no `.git/`) and on any git
 * error so the caller can fall back to other locks rather than aborting
 * on an opaque rev-parse failure.
 */
export const getOriginMainSha = async (dir: string): Promise<string | undefined> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])
    const sha = stdout.trim()
    return sha.length > 0 ? sha : undefined
  } catch {
    return undefined
  }
}
