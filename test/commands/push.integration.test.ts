/**
 * Integration tests for `qfg push` / `runPush` driving REAL local git repos
 * for the diff computation, with the server-side commit replaced by a fake
 * `pushToServer` dep.
 *
 * Post-qfg-azk.13, runPush no longer pushes via git — it sends FileDelta[]
 * to the `configs.push` oRPC procedure and the server commits. These tests
 * exercise:
 *
 *   1. Clone-path happy    — local is a clone of origin, user edits a file.
 *                            FileDelta is sent with beforeJson + afterJson;
 *                            --yes bypasses the Y/N prompt; commitSha echoes
 *                            back from the fake server.
 *   2. Bare-path happy     — local has no .git/, origin has different content.
 *                            FileDeltas mix add/modify/delete with correct
 *                            before/after content from the probe-clone walker.
 *   3. Pin mismatch abort  — local quonfig.json pin disagrees with
 *                            `--workspace`; runPush throws IDENTITY_ABORT.
 *   4. Destructive typed-  — 15 deletes forces typed-slug; --yes does NOT
 *      slug prompt           skip it; injected confirmTypedSlug=false aborts;
 *                            typed slug proceeds.
 *   5. Conflict mapping    — server returns CONFLICT; runPush throws
 *                            PushFatalError(CONFLICT) with a `qfg pull` hint.
 *   6. No-op short-circuit — local matches origin; runPush returns `no-op`
 *                            without calling pushToServer.
 */

import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

import {computeBarePathDiff} from '../../src/push/bare-path-diff.js'
import {
  PushFatalError,
  runPush,
  type ConfigPushInput,
  type ConfigPushResult,
  type GitOps,
  type GiteaTokenMintResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'
import {FileDelta} from '../../src/push/diff-summary.js'
import {dirtyTrackedFiles, getRemoteUrl, gitFetch, gitSetRemote, isGitRepo, isLocalBehindOrDivergedFromRemote} from '../../src/util/git-ops.js'

// Stable test identity so commits are reproducible across hosts.
const TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Integration Test',
  GIT_AUTHOR_EMAIL: 'integration@test.quonfig',
  GIT_COMMITTER_NAME: 'Integration Test',
  GIT_COMMITTER_EMAIL: 'integration@test.quonfig',
}

const FAKE_COMMIT_SHA = 'cafebabe1122334455667788'

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

function countRemoteFiles(remoteDir: string): number {
  const out = execFileSync('git', ['-C', remoteDir, 'ls-tree', '-r', '--name-only', 'main'], {
    encoding: 'utf8',
    env: TEST_ENV,
  })
  return out.split('\n').filter((l) => l.trim().length > 0).length
}

interface CapturedCalls {
  mint: Array<{requestedTarget: string}>
  pushToServer: ConfigPushInput[]
}

/**
 * Build a `RunPushDeps` mirroring `buildRealDeps` (real git diff + real
 * probe-clone) but with the network/IO layers stubbed:
 *
 *   - `mintWriteToken`: returns a fixed backend identity pointing at the
 *     local bare repo URL.
 *   - `validate`: no-op (empty errors).
 *   - `gitOps`: REAL implementations from src/util/git-ops.ts plus the
 *     real diffHeadVsOrigin helper (which now reads before/after JSON via
 *     `git show`).
 *   - `pushToServer`: configurable fake — captures the input and returns
 *     the configured `ConfigPushResult`.
 *   - confirm prompts: driven by the passed-in PassThrough.
 */
function buildTestDeps(args: {
  remoteUrl: string
  backendSlug?: string
  io: {input: PassThrough; output: PassThrough}
  pushResult?: ConfigPushResult
}): {
  deps: RunPushDeps
  calls: CapturedCalls
  cleanup: () => void
} {
  const calls: CapturedCalls = {mint: [], pushToServer: []}
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
          const out = execFileSync('git', ['-C', dir, 'diff', '--name-status', 'origin/main..HEAD'], {
            encoding: 'utf8',
            env: TEST_ENV,
          })
          const deltas: FileDelta[] = []
          for (const raw of out.split('\n')) {
            const line = raw.trim()
            if (!line) continue
            const [status, ...rest] = line.split(/\s+/)
            const pathStr = rest.join(' ')
            if (!pathStr) continue
            if (status.startsWith('A')) {
              const afterJson = readWorkingTreeFile(dir, pathStr)
              deltas.push({kind: 'added', path: pathStr, ...(afterJson === undefined ? {} : {afterJson})})
            } else if (status.startsWith('D')) {
              const beforeJson = showAtRef(dir, 'origin/main', pathStr)
              deltas.push({kind: 'deleted', path: pathStr, ...(beforeJson === undefined ? {} : {beforeJson})})
            } else if (status.startsWith('M') || status.startsWith('R') || status.startsWith('C')) {
              const beforeJson = showAtRef(dir, 'origin/main', pathStr)
              const afterJson = readWorkingTreeFile(dir, pathStr)
              deltas.push({
                kind: 'modified',
                path: pathStr,
                ...(beforeJson === undefined ? {} : {beforeJson}),
                ...(afterJson === undefined ? {} : {afterJson}),
              })
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
    async countFilesInRemote(dir) {
      if (await isGitRepo(dir)) {
        try {
          const out = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'origin/main'], {
            encoding: 'utf8',
            env: TEST_ENV,
          })
          const count = out.split('\n').filter((l) => l.trim().length > 0).length
          if (count > 0) return count
        } catch {
          /* fall through */
        }
      }

      const probe = await ensureBarePathProbe(dir)
      return probe.totalRemoteFiles
    },
    async isLocalBehindRemote(dir) {
      if (!(await isGitRepo(dir))) return false
      return isLocalBehindOrDivergedFromRemote(dir)
    },
    async dirtyTrackedFiles(dir) {
      if (!(await isGitRepo(dir))) return []
      try {
        return await dirtyTrackedFiles(dir)
      } catch {
        return []
      }
    },
    async getOriginMainSha(dir) {
      // qfg-gj3i: mirror buildRealDeps — return the local origin/main SHA
      // for clone-path dirs, undefined for bare path. Use execFileSync so
      // the integration assertion can compare against the same SHA the
      // bare-repo seeded.
      if (!(await isGitRepo(dir))) return undefined
      try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', 'origin/main'], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
        return out.length > 0 ? out : undefined
      } catch {
        return undefined
      }
    },
  }

  const deps: RunPushDeps = {
    async mintWriteToken(requestedTarget) {
      calls.mint.push({requestedTarget})
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
      return {errors: []}
    },
    gitOps,
    async pushToServer(input) {
      calls.pushToServer.push(input)
      return args.pushResult ?? {kind: 'success', commitSha: FAKE_COMMIT_SHA}
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

function showAtRef(dir: string, ref: string, relPath: string): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'show', `${ref}:${relPath}`], {encoding: 'utf8', env: TEST_ENV})
  } catch {
    return undefined
  }
}

function readWorkingTreeFile(dir: string, relPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, relPath), 'utf8')
  } catch {
    return undefined
  }
}

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

describe('runPush: integration against real local bare git repos (server-side commit)', () => {
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
    it('sends a modified-file FileDelta with beforeJson + afterJson and returns the server commitSha', async () => {
      const {remoteUrl} = createBareRemote(root)
      const quonfigJson = JSON.stringify({workspace: 'acme/acme-prod'}) + '\n'
      seedRemote(remoteUrl, root, {
        'quonfig.json': quonfigJson,
        'configs/one.json': '{"k":1}\n',
        'configs/two.json': '{"k":2}\n',
      })

      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)

      writeFiles(local, {'configs/one.json': '{"k":99}\n'})
      commitAll(local, 'local edit to one.json')

      const io = makeIo() // --yes bypasses Y/N
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
          expect(result.commitSha).to.equal(FAKE_COMMIT_SHA)
        }
      } finally {
        cleanup()
      }

      expect(calls.pushToServer).to.have.length(1)
      const sent = calls.pushToServer[0]
      expect(sent.workspaceId).to.equal('acme-prod')
      expect(sent.files).to.have.length(1)
      const f = sent.files[0]
      expect(f.kind).to.equal('modify')
      expect(f.path).to.equal('configs/one.json')
      expect(f.beforeJson).to.equal('{"k":1}\n')
      expect(f.afterJson).to.equal('{"k":99}\n')

      // qfg-gj3i: clone path forwards the local origin/main SHA so the
      // server can reject the push if origin moved between fetch and now.
      const expectedOriginSha = git(local, 'rev-parse', 'origin/main')
      expect(sent.expectedSha).to.equal(expectedOriginSha)
    })
  })

  describe('2. bare-path happy', () => {
    it('sends FileDeltas for add/modify/delete from a no-.git/ local against a divergent origin', async () => {
      const {remoteUrl} = createBareRemote(root)
      const seeded: Record<string, string> = {
        'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n',
      }
      for (let i = 0; i < 10; i++) seeded[`configs/c${i}.json`] = `{"k":${i}}\n`
      seedRemote(remoteUrl, root, seeded)

      const local = fs.mkdtempSync(path.join(root, 'bare-'))
      const localFiles: Record<string, string> = {
        'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n',
        'configs/c0.json': '{"k":111}\n', // modified
        'configs/new.json': '{"k":42}\n', // added
      }
      for (let i = 1; i < 9; i++) localFiles[`configs/c${i}.json`] = `{"k":${i}}\n`
      // configs/c9.json omitted => 1 delete (~9% of 11, not destructive)
      writeFiles(local, localFiles)

      const io = makeIo('y\n') // non-destructive Y/N
      const {deps, calls, cleanup} = buildTestDeps({remoteUrl, io})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'acme-prod',
          yes: false, // exercise the real Y/N
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.dispatchedAs).to.equal('bare-path')
          expect(result.commitSha).to.equal(FAKE_COMMIT_SHA)
        }
      } finally {
        cleanup()
      }

      expect(calls.pushToServer).to.have.length(1)
      const sent = calls.pushToServer[0]
      const byPath = new Map(sent.files.map((f) => [f.path, f]))

      const add = byPath.get('configs/new.json')!
      expect(add.kind).to.equal('add')
      expect(add.afterJson).to.equal('{"k":42}\n')
      expect(add.beforeJson).to.equal(undefined)

      const mod = byPath.get('configs/c0.json')!
      expect(mod.kind).to.equal('modify')
      expect(mod.beforeJson).to.equal('{"k":0}\n')
      expect(mod.afterJson).to.equal('{"k":111}\n')

      const del = byPath.get('configs/c9.json')!
      expect(del.kind).to.equal('delete')
      expect(del.beforeJson).to.equal('{"k":9}\n')
      expect(del.afterJson).to.equal(undefined)

      // qfg-gj3i: bare path has no `.git/`, so expectedSha is omitted.
      // Server treats absence as "non-clone client" and applies its
      // bare-path lock policy.
      expect(sent.expectedSha).to.equal(undefined)
    })
  })

  describe('3. pin mismatch abort', () => {
    it('throws IDENTITY_ABORT when quonfig.json pin disagrees with --workspace; pushToServer is never called', async () => {
      const {remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'other-org/other-ws'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)
      writeFiles(local, {'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n'})
      commitAll(local, 'pin to acme-prod locally')

      const io = makeIo()
      const {deps, calls, cleanup} = buildTestDeps({remoteUrl, io, backendSlug: 'other-ws'})
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

      expect(calls.pushToServer).to.deep.equal([])
    })
  })

  describe('4. destructive-delete typed-slug prompt', () => {
    it('--yes does NOT skip typed-slug; EOF aborts; typed slug proceeds', async () => {
      const {remoteUrl, remoteDir} = createBareRemote(root)
      const seeded: Record<string, string> = {
        'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n',
      }
      for (let i = 0; i < 20; i++) seeded[`configs/c${i}.json`] = `{"k":${i}}\n`
      seedRemote(remoteUrl, root, seeded)
      expect(countRemoteFiles(remoteDir)).to.equal(21)

      // sub-case A: --yes + EOF at typed-slug => aborted
      {
        const local = path.join(root, 'work-abort')
        cloneRemoteTo(remoteUrl, local)
        const toDelete: string[] = []
        for (let i = 0; i < 15; i++) toDelete.push(`configs/c${i}.json`)
        deleteFiles(local, toDelete)
        commitAll(local, 'delete 15 configs')

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
          expect(result.kind).to.equal('aborted')
        } finally {
          cleanup()
        }

        expect(calls.pushToServer).to.deep.equal([])
      }

      // sub-case B: typed slug => proceeds, pushToServer is called
      {
        const local = path.join(root, 'work-proceed')
        cloneRemoteTo(remoteUrl, local)
        const toDelete: string[] = []
        for (let i = 0; i < 15; i++) toDelete.push(`configs/c${i}.json`)
        deleteFiles(local, toDelete)
        commitAll(local, 'delete 15 configs (will be typed through)')

        const io = makeIo('acme-prod\n')
        const {deps, calls, cleanup} = buildTestDeps({remoteUrl, io})
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

        expect(calls.pushToServer).to.have.length(1)
        const sent = calls.pushToServer[0]
        expect(sent.files.filter((f) => f.kind === 'delete')).to.have.length(15)
      }
    })
  })

  describe('5. CONFLICT mapping', () => {
    it('translates a server CONFLICT into PushFatalError(CONFLICT) with a `qfg pull` hint', async () => {
      const {remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)
      writeFiles(local, {'configs/one.json': '{"k":99,"from":"me"}\n'})
      commitAll(local, 'my local edit')

      const io = makeIo()
      const {deps, cleanup} = buildTestDeps({
        remoteUrl,
        io,
        pushResult: {
          kind: 'conflict',
          message: 'configs/one.json was modified (expected ..., got ...)',
        },
      })
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
          expect(pe.code).to.equal('CONFLICT')
          expect(pe.message.toLowerCase()).to.include('qfg pull')
        }
      } finally {
        cleanup()
      }
    })
  })

  describe('6. no-op short-circuit', () => {
    it('returns no-op without calling pushToServer when local matches origin exactly', async () => {
      const {remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)

      const io = makeIo()
      const {deps, calls, cleanup} = buildTestDeps({remoteUrl, io})
      try {
        const input: RunPushInput = {
          dir: local,
          requestedTarget: 'acme-prod',
          yes: false,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('no-op')
      } finally {
        cleanup()
      }

      expect(calls.pushToServer).to.deep.equal([])
    })
  })
})
