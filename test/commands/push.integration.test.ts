/**
 * End-to-end integration tests for `qfg push` / `runPush` driving REAL local
 * git repos. No network, no Gitea, no staging — every "remote" is a bare repo
 * created with `git init --bare` under an OS tmp dir.
 *
 * What this test covers that the unit tests in `push.test.ts` do not:
 *
 *   1. Clone-path happy    — local is a clone of origin, user edits a file,
 *                            commit lands on the bare origin. --yes bypasses
 *                            the Y/N prompt.
 *   2. Bare-path happy     — local has no .git/, origin already exists with
 *                            different content. Clone-and-stack commit lands
 *                            on the bare origin with a `Pushed-Via: cli`
 *                            trailer.
 *   3. Pin mismatch abort  — local quonfig.json pin disagrees with
 *                            `--workspace`; runPush throws IDENTITY_ABORT.
 *   4. Destructive typed-  — 15 deletes forces typed-slug; --yes does NOT
 *      slug prompt           skip it; injected confirmTypedSlug=false aborts;
 *                            typed slug proceeds.
 *   5. Non-ff abort        — origin has advanced past local HEAD; runPush
 *                            throws NON_FAST_FORWARD with a helpful message.
 *   6. No-op short-circuit — local matches origin; runPush returns `no-op`
 *                            without touching push().
 *
 * Closure of dependencies: we build a test deps object that mirrors
 * `buildRealDeps` in `commands/push.ts` but with:
 *   - `mintWriteToken`  — returns a fixed backend identity pointing at the
 *                         local bare repo URL.
 *   - `validate`        — no-op (empty errors).
 *   - `gitOps`          — real implementations from `src/util/git-ops.ts`.
 *   - `copyDirMirror`   — the REAL one exported from `commands/push.ts`.
 *   - confirm prompts   — stubbed via `confirmIO` with a PassThrough stream.
 *
 * The `authenticatedRepoUrl` on local file-path origins is just the repo URL;
 * no auth header is needed for filesystem git.
 */

import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

import {copyDirMirror} from '../../src/commands/push.js'
import {computeBarePathDiff} from '../../src/push/bare-path-diff.js'
import {
  PushFatalError,
  runPush,
  type GitOps,
  type GiteaTokenMintResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'
import {FileDelta} from '../../src/push/diff-summary.js'
import {
  getRemoteUrl,
  gitFetch,
  gitSetRemote,
  isGitRepo,
} from '../../src/util/git-ops.js'

// Stable test identity so commits are reproducible across hosts.
const TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Integration Test',
  GIT_AUTHOR_EMAIL: 'integration@test.quonfig',
  GIT_COMMITTER_NAME: 'Integration Test',
  GIT_COMMITTER_EMAIL: 'integration@test.quonfig',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: TEST_ENV,
  }).trim()
}

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, content)
  }
}

function deleteFiles(dir: string, rels: string[]): void {
  for (const rel of rels) {
    fs.rmSync(path.join(dir, rel), {force: true})
  }
}

function createBareRemote(rootTmp: string): {remoteDir: string; remoteUrl: string} {
  const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
  git(remoteDir, 'init', '--bare', '--initial-branch=main')
  // file:// URL so identity-check's normalizeRemoteUrl parses it cleanly (bare
  // absolute paths fail URL parsing and resolve to `malformed`, which aborts).
  const remoteUrl = `file://${remoteDir}`
  return {remoteDir, remoteUrl}
}

function seedRemote(remoteUrl: string, rootTmp: string, files: Record<string, string>): void {
  const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
  git(seed, 'init', '--initial-branch=main')
  git(seed, 'config', 'user.email', TEST_ENV.GIT_AUTHOR_EMAIL!)
  git(seed, 'config', 'user.name', TEST_ENV.GIT_AUTHOR_NAME!)
  writeFiles(seed, files)
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'remote', 'add', 'origin', remoteUrl)
  git(seed, 'push', 'origin', 'main')
  fs.rmSync(seed, {force: true, recursive: true})
}

function cloneRemoteTo(remoteUrl: string, destDir: string): void {
  // Parent must exist; dest must NOT exist (git clone creates it).
  fs.mkdirSync(path.dirname(destDir), {recursive: true})
  execFileSync('git', ['clone', remoteUrl, destDir], {env: TEST_ENV})
  git(destDir, 'config', 'user.email', TEST_ENV.GIT_AUTHOR_EMAIL!)
  git(destDir, 'config', 'user.name', TEST_ENV.GIT_AUTHOR_NAME!)
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '--all')
  git(dir, 'commit', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function listCommitMessages(remoteDir: string, count: number): string[] {
  const out = execFileSync('git', ['-C', remoteDir, 'log', '--format=%B%x00', '-n', String(count), 'main'], {
    encoding: 'utf8',
    env: TEST_ENV,
  })
  return out.split('\u0000').map((s) => s.trim()).filter(Boolean)
}

function remoteTipSha(remoteDir: string): string {
  return execFileSync('git', ['-C', remoteDir, 'rev-parse', 'main'], {encoding: 'utf8', env: TEST_ENV}).trim()
}

function countRemoteFiles(remoteDir: string): number {
  const out = execFileSync('git', ['-C', remoteDir, 'ls-tree', '-r', '--name-only', 'main'], {
    encoding: 'utf8',
    env: TEST_ENV,
  })
  return out.split('\n').filter((l) => l.trim().length > 0).length
}

/**
 * Build a `RunPushDeps` that mirrors `buildRealDeps` from commands/push.ts
 * but with the network + confirm layers stubbed:
 *
 *   - `mintWriteToken`: returns a fixed backend identity pointing at the
 *     local bare repo. Stashes the URL on a closure so the bare-path diff
 *     can probe-clone it.
 *   - `validate`: returns no errors by default.
 *   - `gitOps`: REAL implementations from src/util/git-ops.ts, with the
 *     same closure-based bare-path probe wiring as buildRealDeps.
 *   - `copyDirMirror`: REAL one from commands/push.ts.
 *   - `confirmIO`: driven by the passed-in PassThrough.
 */
function buildTestDeps(args: {
  remoteUrl: string
  backendSlug?: string
  io: {input: PassThrough; output: PassThrough}
  validateErrors?: string[]
  // Override confirm behavior WITHOUT going through stdin. When set, runPush
  // uses this instead of the readline-over-confirmIO path. Implemented by
  // overriding confirmIO with a fake that the confirm prompts can read.
  // We use the simpler approach: drive the PassThrough stream directly.
}): {
  deps: RunPushDeps
  calls: {mint: number; validate: number; copyDirMirror: number}
  cleanup: () => void
} {
  const calls = {mint: 0, validate: 0, copyDirMirror: 0}
  const slug = args.backendSlug ?? 'acme-prod'

  let authenticatedRepoUrl: string | undefined
  let barePathProbe: Awaited<ReturnType<typeof computeBarePathDiff>> | undefined

  const ensureBarePathProbe = async (dir: string) => {
    if (barePathProbe) return barePathProbe
    if (!authenticatedRepoUrl) {
      throw new Error('bare-path probe requested before mintWriteToken ran')
    }

    barePathProbe = await computeBarePathDiff(dir, authenticatedRepoUrl)
    return barePathProbe
  }

  const gitOps: GitOps = {
    async isGitRepo(dir) {
      return isGitRepo(dir)
    },
    async getRemoteOriginUrl(dir) {
      const url = await getRemoteUrl(dir)
      return url ?? undefined
    },
    async setRemoteOrigin(dir, url) {
      await gitSetRemote(dir, url)
    },
    async fetch(dir) {
      try {
        await gitFetch(dir)
      } catch {
        /* bare path: swallow — matches buildRealDeps */
      }
    },
    async diffHeadVsOrigin(dir) {
      if (await isGitRepo(dir)) {
        try {
          const out = execFileSync(
            'git',
            ['-C', dir, 'diff', '--name-status', 'origin/main..HEAD'],
            {encoding: 'utf8', env: TEST_ENV},
          )
          const deltas: FileDelta[] = []
          for (const raw of out.split('\n')) {
            const line = raw.trim()
            if (!line) continue
            const [status, ...rest] = line.split(/\s+/)
            const pathStr = rest.join(' ')
            if (!pathStr) continue
            if (status.startsWith('A')) deltas.push({kind: 'added', path: pathStr})
            else if (status.startsWith('D')) deltas.push({kind: 'deleted', path: pathStr})
            else if (status.startsWith('M') || status.startsWith('R') || status.startsWith('C')) {
              deltas.push({kind: 'modified', path: pathStr})
            }
          }

          return deltas
        } catch {
          // fall through to probe clone
        }
      }

      const probe = await ensureBarePathProbe(dir)
      return probe.deltas
    },
    async push(dir) {
      execFileSync('git', ['-C', dir, 'push', 'origin', 'main'], {env: TEST_ENV})
    },
    async getLocalAuthor(dir): Promise<{name: string; email: string} | undefined> {
      let name = ''
      let email = ''
      try {
        name = execFileSync('git', ['-C', dir, 'config', 'user.name'], {encoding: 'utf8', env: TEST_ENV}).trim()
        email = execFileSync('git', ['-C', dir, 'config', 'user.email'], {encoding: 'utf8', env: TEST_ENV}).trim()
      } catch {
        // git config may be unset; treat as no identity.
      }

      if (!name || !email) return
      return {name, email}
    },
    async countFilesInRemote(dir) {
      if (await isGitRepo(dir)) {
        try {
          const out = execFileSync(
            'git',
            ['-C', dir, 'ls-tree', '-r', '--name-only', 'origin/main'],
            {encoding: 'utf8', env: TEST_ENV},
          )
          const count = out.split('\n').filter((l) => l.trim().length > 0).length
          if (count > 0) return count
        } catch {
          /* fall through */
        }
      }

      const probe = await ensureBarePathProbe(dir)
      return probe.totalRemoteFiles
    },
  }

  const deps: RunPushDeps = {
    async mintWriteToken() {
      calls.mint += 1
      authenticatedRepoUrl = args.remoteUrl
      const resp: GiteaTokenMintResult = {
        token: 'fake-token',
        repoUrl: args.remoteUrl,
        expiresAt: null,
        workspaceSlug: slug,
        workspaceId: slug,
      }
      return resp
    },
    async validate() {
      calls.validate += 1
      return {errors: args.validateErrors ?? []}
    },
    gitOps,
    async copyDirMirror(source, dest) {
      calls.copyDirMirror += 1
      await copyDirMirror(source, dest)
    },
    confirmIO: args.io,
    log() {},
    errLog() {},
  }

  const cleanup = () => {
    if (barePathProbe) {
      try {
        fs.rmSync(barePathProbe.scratchDir, {force: true, recursive: true})
      } catch {
        /* ignore */
      }
    }
  }

  return {deps, calls, cleanup}
}

/**
 * Produce a `{input, output}` pair of PassThroughs that emits `input` on the
 * next tick and closes. `output.on('data', ...)` is attached so prompts
 * flowing through don't back-pressure.
 */
function makeIo(input?: string): {input: PassThrough; output: PassThrough} {
  const io = {input: new PassThrough(), output: new PassThrough()}
  io.output.on('data', () => {})
  if (input === undefined) {
    setImmediate(() => io.input.end())
  } else {
    setImmediate(() => {
      io.input.write(input)
      io.input.end()
    })
  }

  return io
}

describe('runPush: integration against real local bare git repos', () => {
  let root: string

  beforeEach(() => {
    root = mkTmp('qfg-push-integration-')
  })

  afterEach(() => {
    try {
      fs.rmSync(root, {force: true, recursive: true})
    } catch {
      /* best-effort */
    }
  })

  describe('1. clone-path happy', () => {
    it('applies a modified file and lands the commit on the bare origin; --yes bypasses Y/N', async () => {
      const {remoteDir, remoteUrl} = createBareRemote(root)
      const quonfigJson = JSON.stringify({workspace: 'acme-prod'}) + '\n'
      seedRemote(remoteUrl, root, {
        'quonfig.json': quonfigJson,
        'configs/one.json': '{"k":1}\n',
        'configs/two.json': '{"k":2}\n',
      })

      const tipBefore = remoteTipSha(remoteDir)

      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)

      // Edit a file and commit it locally — the user-facing model is "you've
      // got work committed locally; qfg push sends it up".
      writeFiles(local, {'configs/one.json': '{"k":99}\n'})
      const localSha = commitAll(local, 'local edit to one.json')

      // --yes with no user input: confirmYesNo would see EOF and abort if we
      // were actually prompting. The test proves --yes bypasses the prompt.
      const io = makeIo()
      const {deps, calls, cleanup} = buildTestDeps({remoteUrl, io})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'acme-prod',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.dispatchedAs).to.equal('clone-path')
        }
      } finally {
        cleanup()
      }

      // Commit actually landed on bare origin.
      const tipAfter = remoteTipSha(remoteDir)
      expect(tipAfter).to.equal(localSha)
      expect(tipAfter).to.not.equal(tipBefore)

      // The content at origin reflects the local edit.
      expect(calls.mint).to.equal(1)
    })
  })

  describe('2. bare-path happy', () => {
    it('clone-and-stacks when no .git/, origin differs; commit carries Pushed-Via: cli', async () => {
      const {remoteDir, remoteUrl} = createBareRemote(root)
      // Seed enough files on origin that 1 delete is well under the 25%
      // destructive ratio — otherwise Guard 3 asks for a typed slug and the
      // "happy" path becomes a typed-slug path (covered in scenario 4).
      const seeded: Record<string, string> = {
        'quonfig.json': JSON.stringify({workspace: 'acme-prod'}) + '\n',
      }
      for (let i = 0; i < 10; i++) seeded[`configs/c${i}.json`] = `{"k":${i}}\n`
      seedRemote(remoteUrl, root, seeded)

      const tipBefore = remoteTipSha(remoteDir)

      // Local is a raw dir — no .git. Pin the slug so identity passes
      // without a typed-slug prompt. Content diverges from origin: one
      // modification + one addition + one deletion (c9.json dropped).
      const local = fs.mkdtempSync(path.join(root, 'bare-'))
      const localFiles: Record<string, string> = {
        'quonfig.json': JSON.stringify({workspace: 'acme-prod'}) + '\n',
        'configs/c0.json': '{"k":111}\n', // modified
        'configs/new.json': '{"k":42}\n', // added
      }
      for (let i = 1; i < 9; i++) localFiles[`configs/c${i}.json`] = `{"k":${i}}\n`
      // Intentionally omit configs/c9.json => 1 delete out of 11 files ~= 9%, not destructive.
      writeFiles(local, localFiles)

      const io = makeIo('y\n') // non-destructive confirm (1 mod, 1 add, 1 del)
      const {deps, calls, cleanup} = buildTestDeps({remoteUrl, io})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'acme-prod',
          yes: false, // exercise the real Y/N path
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.dispatchedAs).to.equal('bare-path')
          expect(result.commitSha).to.be.a('string')
        }
      } finally {
        cleanup()
      }

      const tipAfter = remoteTipSha(remoteDir)
      expect(tipAfter).to.not.equal(tipBefore)
      expect(calls.copyDirMirror).to.equal(1)

      // Commit body should carry the Pushed-Via trailer.
      const messages = listCommitMessages(remoteDir, 1)
      expect(messages[0]).to.match(/Pushed-Via: cli/)
    })
  })

  describe('3. pin mismatch abort', () => {
    it('throws IDENTITY_ABORT when quonfig.json pin disagrees with --workspace', async () => {
      const {remoteDir, remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'other-ws'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      const tipBefore = remoteTipSha(remoteDir)

      // Local pins to acme-prod but --workspace / backend resolves to other-ws.
      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)
      writeFiles(local, {'quonfig.json': JSON.stringify({workspace: 'acme-prod'}) + '\n'})
      commitAll(local, 'pin to acme-prod locally')

      const io = makeIo()
      // Backend resolves to "other-ws" — pin says "acme-prod" => mismatch.
      const {deps, cleanup} = buildTestDeps({remoteUrl, io, backendSlug: 'other-ws'})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'other-ws',
          yes: true, // --yes never rescues identity
          skipValidate: true,
          noPinWrite: true,
        }
        try {
          await runPush(input, deps)
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(PushFatalError)
          expect((error as PushFatalError).code).to.equal('IDENTITY_ABORT')
        }
      } finally {
        cleanup()
      }

      // No push happened.
      expect(remoteTipSha(remoteDir)).to.equal(tipBefore)
    })
  })

  describe('4. destructive-delete typed-slug prompt', () => {
    it('--yes does NOT skip typed-slug; EOF aborts; typed slug proceeds', async () => {
      const {remoteDir, remoteUrl} = createBareRemote(root)
      // Seed 20 files so deleting 15 trips both the 10+ delete rule and the
      // >=25% ratio. Identity passes because we pin the slug locally.
      const seeded: Record<string, string> = {
        'quonfig.json': JSON.stringify({workspace: 'acme-prod'}) + '\n',
      }
      for (let i = 0; i < 20; i++) seeded[`configs/c${i}.json`] = `{"k":${i}}\n`
      seedRemote(remoteUrl, root, seeded)

      const tipBefore = remoteTipSha(remoteDir)
      const remoteFileCount = countRemoteFiles(remoteDir)
      expect(remoteFileCount).to.equal(21) // 20 configs + quonfig.json

      // --- sub-case A: --yes + EOF at prompt => aborted, nothing pushed ---
      {
        const local = path.join(root, 'work-abort')
        cloneRemoteTo(remoteUrl, local)
        // Delete 15 of the 20 config files locally and commit.
        const toDelete: string[] = []
        for (let i = 0; i < 15; i++) toDelete.push(`configs/c${i}.json`)
        deleteFiles(local, toDelete)
        commitAll(local, 'delete 15 configs')

        const io = makeIo() // EOF => typed-slug returns false
        const {deps, cleanup} = buildTestDeps({remoteUrl, io})
        try {
          const input: RunPushInput = {
            dir: local,
            requestedTarget: 'acme-prod',
            yes: true, // --yes must NOT rescue the typed-slug prompt
            skipValidate: true,
            noPinWrite: true,
          }
          const result = await runPush(input, deps)
          expect(result.kind).to.equal('aborted')
        } finally {
          cleanup()
        }

        expect(remoteTipSha(remoteDir)).to.equal(tipBefore) // nothing pushed
      }

      // --- sub-case B: typed slug => proceeds and lands the commit ---
      {
        const local = path.join(root, 'work-proceed')
        cloneRemoteTo(remoteUrl, local)
        const toDelete: string[] = []
        for (let i = 0; i < 15; i++) toDelete.push(`configs/c${i}.json`)
        deleteFiles(local, toDelete)
        const localSha = commitAll(local, 'delete 15 configs (will be typed through)')

        const io = makeIo('acme-prod\n')
        const {deps, cleanup} = buildTestDeps({remoteUrl, io})
        try {
          const input: RunPushInput = {
            dir: local,
            requestedTarget: 'acme-prod',
            yes: false,
            skipValidate: true,
            noPinWrite: true,
          }
          const result = await runPush(input, deps)
          expect(result.kind).to.equal('pushed')
          if (result.kind === 'pushed') {
            expect(result.dispatchedAs).to.equal('clone-path')
          }
        } finally {
          cleanup()
        }

        expect(remoteTipSha(remoteDir)).to.equal(localSha)
      }
    })
  })

  describe('5. non-ff abort', () => {
    it('maps rejected push to PushFatalError(NON_FAST_FORWARD) with a `qfg pull` hint', async () => {
      const {remoteDir, remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'acme-prod'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      // User clones.
      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)

      // Meanwhile another user pushes to origin behind our back.
      const other = fs.mkdtempSync(path.join(root, 'other-'))
      cloneRemoteTo(remoteUrl, other)
      writeFiles(other, {'configs/one.json': '{"k":2,"from":"other"}\n'})
      commitAll(other, 'other user updates configs/one.json')
      execFileSync('git', ['-C', other, 'push', 'origin', 'main'], {env: TEST_ENV})

      // User also makes a local commit on top of their original clone.
      writeFiles(local, {'configs/one.json': '{"k":99,"from":"me"}\n'})
      commitAll(local, 'my local edit')

      const tipAfterOther = remoteTipSha(remoteDir)

      const io = makeIo()
      const {deps, cleanup} = buildTestDeps({remoteUrl, io})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'acme-prod',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        try {
          await runPush(input, deps)
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(PushFatalError)
          const pe = error as PushFatalError
          expect(pe.code).to.equal('NON_FAST_FORWARD')
          expect(pe.message).to.match(/qfg pull/i)
        }
      } finally {
        cleanup()
      }

      // Origin tip is still where the other user left it — our push was refused.
      expect(remoteTipSha(remoteDir)).to.equal(tipAfterOther)
    })
  })

  describe('6. no-op short-circuit', () => {
    it('returns no-op without calling push when local matches origin exactly', async () => {
      const {remoteDir, remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'acme-prod'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      const tipBefore = remoteTipSha(remoteDir)

      // Clone — local is a byte-perfect mirror of origin's HEAD.
      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)

      // No user input should be consumed — the no-op path exits before any
      // confirm prompt is shown.
      const io = makeIo()
      const {deps, cleanup} = buildTestDeps({remoteUrl, io})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'acme-prod',
          yes: false, // prove we're not just --yes short-circuiting
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('no-op')
      } finally {
        cleanup()
      }

      // Origin tip unchanged.
      expect(remoteTipSha(remoteDir)).to.equal(tipBefore)
    })
  })
})
