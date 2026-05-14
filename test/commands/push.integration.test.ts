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
import {computeClonePathDiff} from '../../src/push/clone-path-diff.js'
import {
  PushFatalError,
  runPush,
  type ConfigPushInput,
  type ConfigPushResult,
  type GitOps,
  type GitPushInput,
  type GitPushResult,
  type GiteaTokenMintResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'
import {
  dirtyTrackedFiles,
  getAllRemoteUrls,
  getRemoteUrl,
  gitFetch,
  gitSetRemote,
  isGitRepo,
  isLocalBehindOrDivergedFromRemote,
} from '../../src/util/git-ops.js'

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
  /** Pack-push (qfg-7429.4) — clone-path now ships via `configs.gitPush`. */
  pushPackToServer: GitPushInput[]
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
  /** Pack-push (qfg-7429.4) — controls the response from the gitPush stub. */
  packPushResult?: GitPushResult
}): {
  deps: RunPushDeps
  calls: CapturedCalls
  cleanup: () => void
} {
  const calls: CapturedCalls = {mint: [], pushToServer: [], pushPackToServer: []}
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
    async getAllRemoteUrls(dir) {
      return getAllRemoteUrls(dir)
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
          // Use production clone-path diff so the integration test exercises
          // real code, not a parallel implementation.
          return await computeClonePathDiff(dir)
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
    async getOriginMainSha(dir): Promise<string | undefined> {
      // qfg-gj3i: mirror buildRealDeps — return the local origin/main SHA
      // for clone-path dirs, undefined for bare path. Use execFileSync so
      // the integration assertion can compare against the same SHA the
      // bare-repo seeded.
      if (!(await isGitRepo(dir))) return
      let out: string | undefined
      try {
        out = execFileSync('git', ['-C', dir, 'rev-parse', 'origin/main'], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
      } catch {
        // bare-path dirs may not have origin/main
      }
      return out && out.length > 0 ? out : undefined
    },
    // Pack-push (qfg-7429.4) — clone-path now ships actual packfiles via
    // configs.gitPush. Use the real helpers from src/push/git-pack and the
    // shell-based git ops so the integration test exercises the production
    // code path. Bare-path tests below still use isGitRepo=false to
    // dispatch to configs.push.
    async getCurrentBranch(dir) {
      const {getCurrentBranch} = await import('../../src/push/git-pack.js')
      return getCurrentBranch(dir)
    },
    async getHeadSha(dir) {
      try {
        return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
      } catch {
        return '0000000000000000000000000000000000000000'
      }
    },
    async getRemoteBranchSha(dir, branchName): Promise<string | undefined> {
      try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', `origin/${branchName}`], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
        return out.length > 0 ? out : undefined
      } catch {
        return undefined
      }
    },
    async buildPack(dir, expectedSha, newSha) {
      const {buildPack} = await import('../../src/push/git-pack.js')
      return buildPack(dir, expectedSha, newSha)
    },
    async countCommitsBetween(dir, expectedSha, newSha) {
      if (expectedSha === newSha) return 0
      try {
        const out = execFileSync('git', ['-C', dir, 'rev-list', '--count', `${expectedSha}..${newSha}`], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
        return Number.parseInt(out, 10) || 0
      } catch {
        return 0
      }
    },
    async getCommitOneline(dir, sha) {
      try {
        return execFileSync('git', ['-C', dir, 'log', '-1', '--pretty=oneline', sha], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
      } catch {
        return ''
      }
    },
    async getTreeShaForRef(dir, ref) {
      try {
        return execFileSync('git', ['-C', dir, 'rev-parse', `${ref}^{tree}`], {
          encoding: 'utf8',
          env: TEST_ENV,
        }).trim()
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
    async pushPackToServer(input) {
      // Pack-push wire (qfg-7429.4). Default success — the SHA echoed
      // back is the SHA the CLI shipped, matching the server contract
      // (server returns input.newSha as commitSha).
      calls.pushPackToServer.push(input)
      return args.packPushResult ?? {kind: 'success', commitSha: input.newSha, ref: input.targetRef}
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
    it('ships a packfile via configs.gitPush and returns the local HEAD SHA back as commitSha', async () => {
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
      const localHeadSha = git(local, 'rev-parse', 'HEAD')

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
          // qfg-7429.4: pack-push echoes back the SHA the CLI shipped.
          expect(result.commitSha).to.equal(localHeadSha)
        }
      } finally {
        cleanup()
      }

      // qfg-7429.4: clone-path now ships actual git objects, not file deltas.
      expect(calls.pushToServer, 'configs.push must NOT be called on clone-path').to.have.length(0)
      expect(calls.pushPackToServer).to.have.length(1)
      const sent = calls.pushPackToServer[0]
      expect(sent.workspaceId).to.equal('acme-prod')
      expect(sent.targetRef).to.equal('refs/heads/main')
      expect(sent.newSha).to.equal(localHeadSha)
      // expectedSha is the origin/main SHA the CLI saw at fetch time.
      expect(sent.expectedSha).to.equal(git(local, 'rev-parse', 'origin/main'))
      // Pack must be a real packfile — git's "PACK" magic.
      expect(sent.pack.byteLength).to.be.greaterThan(0)
      const magic = Buffer.from(sent.pack.subarray(0, 4)).toString('utf8')
      expect(magic).to.equal('PACK')
    })

    // qfg-3fc6 (clone-path): a beta tester dropped a fresh
    // `configs/quonfig.secrets.encryption.key.json` into a pulled dir and
    // ran `qfg push`. The OLD file-delta wire silently picked the file up
    // because it walked the working tree. The NEW pack-push wire matches
    // `git push` semantics — only committed objects ship. Untracked
    // working-tree files are correctly excluded; the existing
    // dirty-tracked warning + new "you have untracked files" UX would
    // surface them as a separate concern. This test locks in the new
    // semantics so a future refactor can't silently re-introduce
    // working-tree pickup on the clone path.
    it('does NOT ship an untracked configs/ file in the pack (matches git push semantics, qfg-7429.4)', async () => {
      const {remoteUrl} = createBareRemote(root)
      seedRemote(remoteUrl, root, {
        'quonfig.json': JSON.stringify({workspace: 'acme/acme-prod'}) + '\n',
        'configs/one.json': '{"k":1}\n',
      })

      const local = path.join(root, 'work')
      cloneRemoteTo(remoteUrl, local)

      // Make a real committed change so the push has something to ship —
      // otherwise it would short-circuit as no-op before reaching the
      // pack-push branch.
      writeFiles(local, {'configs/one.json': '{"k":99}\n'})
      commitAll(local, 'committed edit')

      // User drops a NEW config file into the workspace dir. They never
      // run `git add` / `git commit` — the file is untracked. Pack-push
      // should not include it.
      writeFiles(local, {'configs/quonfig.secrets.encryption.key.json': '{"k":"hex"}\n'})

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
      } finally {
        cleanup()
      }

      // pack-push went through; configs.push is unused on clone-path.
      expect(calls.pushToServer).to.have.length(0)
      expect(calls.pushPackToServer).to.have.length(1)

      // The pack itself is opaque here — assert the COMMITTED file is
      // reachable from newSha (the committed configs/one.json edit) but
      // the UNTRACKED file is not. ls-tree on newSha is the
      // pack-equivalent of "what the server will see after ingesting".
      const sent = calls.pushPackToServer[0]
      const tree = git(local, 'ls-tree', '-r', '--name-only', sent.newSha)
      const treeFiles = new Set(
        tree
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      expect(treeFiles.has('configs/one.json')).to.equal(true)
      expect(
        treeFiles.has('configs/quonfig.secrets.encryption.key.json'),
        'untracked file must NOT be in newSha tree under pack-push',
      ).to.equal(false)
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

      // qfg-7429.4: identity abort fires before either push wire.
      expect(calls.pushToServer).to.deep.equal([])
      expect(calls.pushPackToServer).to.deep.equal([])
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

        // qfg-7429.4: clone-path now ships via pack-push; the typed-slug
        // EOF abort fires before EITHER push wire.
        expect(calls.pushToServer).to.deep.equal([])
        expect(calls.pushPackToServer).to.deep.equal([])
      }

      // sub-case B: typed slug => proceeds, pack-push is called
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

        // qfg-7429.4: clone-path → pack-push wire. The 15 deletes are
        // committed git objects in the new tip; the diff lives in the
        // packfile, not in a JSON file-delta envelope. Verify by
        // walking the new tip on the local repo: the 15 deleted files
        // must be absent from the tree.
        expect(calls.pushPackToServer).to.have.length(1)
        const packSent = calls.pushPackToServer[0]
        const tree = git(local, 'ls-tree', '-r', '--name-only', packSent.newSha)
        const treeFiles = new Set(
          tree
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        )
        for (let i = 0; i < 15; i++) {
          expect(treeFiles.has(`configs/c${i}.json`), `expected configs/c${i}.json to be deleted`).to.equal(false)
        }
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
        // qfg-7429.4: clone-path goes through pack-push, so the
        // conflict result must be set on the gitPush stub.
        packPushResult: {
          kind: 'conflict',
          message: 'OriginMoved: expected ..., current ...',
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
      // qfg-7429.4: no-op short-circuits before either push branch.
      expect(calls.pushPackToServer).to.deep.equal([])
    })
  })
})
