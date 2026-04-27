import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

import {computeBarePathDiff} from '../../src/push/bare-path-diff.js'
import {
  runPush,
  type ConfigPushInput,
  type GitOps,
  type GiteaTokenMintResult,
  type RunPushDeps,
} from '../../src/push/run-push.js'

/**
 * Integration-lite test that stands up a real bare git repo and drives
 * runPush through the bare-path branch using the actual `computeBarePathDiff`
 * helper as the backing implementation for `diffHeadVsOrigin` /
 * `countFilesInRemote`.
 *
 * Mocks out only:
 *   - the token mint (no backend),
 *   - validate (trivially OK),
 *   - the `push` shell call that would normally shell out to git push.
 *
 * This catches integration bugs in the closure-based wiring used by
 * `buildRealDeps` in commands/push.ts — e.g. "diffHeadVsOrigin is called
 * before the authenticated URL is stashed".
 */

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function createBareRemote(rootTmp: string): string {
  const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
  run(remoteDir, 'init', '--bare', '--initial-branch=main')
  return remoteDir
}

function seedRemoteWith(remoteDir: string, rootTmp: string, files: Record<string, string>): void {
  const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
  run(seed, 'init', '--initial-branch=main')
  run(seed, 'config', 'user.email', 'seed@test')
  run(seed, 'config', 'user.name', 'Seed')
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(seed, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, content)
  }

  run(seed, 'add', '.')
  run(seed, 'commit', '-m', 'seed')
  run(seed, 'remote', 'add', 'origin', remoteDir)
  run(seed, 'push', 'origin', 'main')
}

function writeLocal(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, content)
  }
}

/**
 * Build the same closure-wired gitOps that `commands/push.ts` uses for the
 * bare path, but backed by the local bare repo in `remoteUrl` and wrapping
 * push() as a no-op since we only want to drive runPush far enough to
 * verify the diff summary + dispatch.
 */
function buildBarePathDepsForTest(
  remoteUrl: string,
  io: {input: PassThrough; output: PassThrough},
): {
  deps: RunPushDeps
  cleanup: () => void
  calls: {pushToServer: ConfigPushInput[]}
} {
  let authenticatedRepoUrl: string | undefined
  let probe: Awaited<ReturnType<typeof computeBarePathDiff>> | undefined
  const calls = {pushToServer: [] as ConfigPushInput[]}

  const ensureProbe = async (dir: string) => {
    if (probe) return probe
    probe = await computeBarePathDiff(dir, authenticatedRepoUrl!)
    return probe
  }

  const gitOps: GitOps = {
    isGitRepo: async () => false,
    getRemoteOriginUrl: async (): Promise<string | undefined> => undefined,
    async setRemoteOrigin() {},
    async fetch() {},
    async diffHeadVsOrigin(dir) {
      const p = await ensureProbe(dir)
      return p.deltas
    },
    async countFilesInRemote(dir) {
      const p = await ensureProbe(dir)
      return p.totalRemoteFiles
    },
  }

  const backend: GiteaTokenMintResult = {
    token: 'x',
    repoUrl: remoteUrl,
    expiresAt: null,
    workspaceSlug: 'test-ws',
    workspaceId: 'test-ws',
  }

  const deps: RunPushDeps = {
    async mintWriteToken() {
      authenticatedRepoUrl = remoteUrl
      return backend
    },
    validate: async () => ({errors: []}),
    gitOps,
    async pushToServer(input) {
      calls.pushToServer.push(input)
      return {kind: 'success', commitSha: 'fake-sha-1234'}
    },
    confirmIO: io,
    log() {},
    errLog() {},
  }

  const cleanup = () => {
    if (probe) {
      try {
        fs.rmSync(probe.scratchDir, {force: true, recursive: true})
      } catch {
        /* ignore */
      }
    }
  }

  return {deps, cleanup, calls}
}

describe('runPush: bare-path with real computeBarePathDiff', () => {
  let root: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-push-bare-')))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('reports no-op when a bare-path local dir matches remote exactly', async () => {
    const remote = createBareRemote(root)
    const quonfigJson = JSON.stringify({workspace: 'test-ws'})
    seedRemoteWith(remote, root, {
      'configs/one.json': '{"k":1}\n',
      'quonfig.json': quonfigJson,
    })

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    // Pin so identity passes without typed-slug.
    fs.writeFileSync(path.join(local, 'quonfig.json'), quonfigJson)
    writeLocal(local, {'configs/one.json': '{"k":1}\n'})

    const io = {input: new PassThrough(), output: new PassThrough()}
    io.output.on('data', () => {})
    setImmediate(() => io.input.end())

    const {deps, cleanup, calls} = buildBarePathDepsForTest(remote, io)
    try {
      const result = await runPush(
        {
          dir: local,
          requestedTarget: 'test-ws',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        },
        deps,
      )
      expect(result.kind).to.equal('no-op')
      expect(calls.pushToServer).to.deep.equal([])
    } finally {
      cleanup()
    }
  })

  it('detects a real add on bare-path and routes to the bare dispatch', async () => {
    const remote = createBareRemote(root)
    seedRemoteWith(remote, root, {
      'configs/one.json': '{"k":1}\n',
    })

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    fs.writeFileSync(path.join(local, 'quonfig.json'), JSON.stringify({workspace: 'test-ws'}))
    writeLocal(local, {
      'configs/one.json': '{"k":1}\n',
      'configs/new.json': '{"k":2}\n', // added
    })

    const io = {input: new PassThrough(), output: new PassThrough()}
    io.output.on('data', () => {})
    // Provide a 'y' so the non-destructive confirm proceeds (or pre-empts).
    setImmediate(() => {
      io.input.write('y\n')
      io.input.end()
    })

    const {deps, cleanup, calls} = buildBarePathDepsForTest(remote, io)
    try {
      // bare-path dispatch now sends FileDelta[] to pushToServer; the fake
      // returns success and runPush propagates the commit SHA.
      const result = await runPush(
        {
          dir: local,
          requestedTarget: 'test-ws',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        },
        deps,
      )
      expect(result.kind).to.equal('pushed')
      if (result.kind === 'pushed') {
        expect(result.dispatchedAs).to.equal('bare-path')
      }

      expect(calls.pushToServer).to.have.length(1)
      const sent = calls.pushToServer[0]
      const add = sent.files.find((f) => f.path === 'configs/new.json')!
      expect(add.kind).to.equal('add')
      expect(add.afterJson).to.equal('{"k":2}\n')
    } finally {
      cleanup()
    }
  })
})
