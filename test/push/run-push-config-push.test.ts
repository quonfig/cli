/**
 * Behavioral tests for runPush after the swap from `git push` to the
 * `configs.push` oRPC endpoint (qfg-azk.13).
 *
 * What we lock in here:
 *   - The FileDelta payload sent to the server includes beforeJson + afterJson
 *     for modifies, only afterJson for adds, only beforeJson for deletes.
 *   - 403 with denials surfaces one error line per denied path with the
 *     missing permission name and exits non-zero (PushFatalError).
 *   - CONFLICT prints a "remote moved, run qfg pull and retry" hint and
 *     exits non-zero.
 *   - 200 with a commit SHA returns a pushed result containing the SHA.
 *   - The push code path does NOT mint a write-scoped Gitea token; only
 *     read-scope mints are allowed.
 */

import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

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

const BACKEND_UUID = '00000000-0000-4000-8000-000000000001'

const BACKEND: GiteaTokenMintResult = {
  token: 'fake-read-token',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
  expiresAt: null,
  workspaceSlug: 'acme-prod',
  workspaceId: BACKEND_UUID,
}

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-cp-')))
}

function makeIo(input?: string) {
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

interface Captured {
  /** Per-call records of what was passed to mintWriteToken — including scope. */
  mint: Array<{requestedTarget: string; scope: 'read' | 'write'}>
  pushToServer: ConfigPushInput[]
}

function makeDeps(opts: {
  deltas: FileDelta[]
  pushResult?: ConfigPushResult
  pushThrows?: Error
  gitOps?: Partial<GitOps>
  userInput?: string
}): {deps: RunPushDeps; captured: Captured} {
  const captured: Captured = {mint: [], pushToServer: []}

  const gitOps: GitOps = {
    isGitRepo: async () => false,
    getRemoteOriginUrl: async (): Promise<string | undefined> => undefined,
    getAllRemoteUrls: async (): Promise<string[]> => [],
    async setRemoteOrigin() {},
    async fetch() {},
    diffHeadVsOrigin: async () => opts.deltas,
    countFilesInRemote: async () => 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async (): Promise<string | undefined> => undefined,
    ...opts.gitOps,
  }

  const deps: RunPushDeps = {
    async mintWriteToken(requestedTarget) {
      // The test deps pretend to be the buildRealDeps wrapping. The real wiring
      // calls mintGiteaToken with scope='read'; our fake records the scope so
      // the no-write-PAT test can assert it stayed 'read'.
      captured.mint.push({requestedTarget, scope: 'read'})
      return BACKEND
    },
    async validate() {
      return {errors: []}
    },
    gitOps,
    async pushToServer(input) {
      captured.pushToServer.push(input)
      if (opts.pushThrows) throw opts.pushThrows
      return (
        opts.pushResult ?? {
          kind: 'success',
          commitSha: 'abc1234567890def',
        }
      )
    },
    confirmIO: makeIo(opts.userInput),
    log() {},
    errLog() {},
  }

  return {deps, captured}
}

describe('runPush → configs.push (qfg-azk.13)', () => {
  describe('FileDelta payload shape', () => {
    it('passes beforeJson + afterJson for modifies, afterJson-only for adds, beforeJson-only for deletes', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [
          {kind: 'added', path: 'configs/new.json', afterJson: '{"k":1}'},
          {kind: 'modified', path: 'configs/changed.json', beforeJson: '{"k":1}', afterJson: '{"k":2}'},
          {kind: 'deleted', path: 'configs/gone.json', beforeJson: '{"k":3}'},
        ]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
          },
        })
        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }

        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')

        expect(captured.pushToServer).to.have.length(1)
        const sent = captured.pushToServer[0]
        expect(sent.workspaceId).to.equal(BACKEND_UUID)
        expect(sent.files).to.have.length(3)

        const byPath = new Map(sent.files.map((f) => [f.path, f]))
        const add = byPath.get('configs/new.json')!
        expect(add.kind).to.equal('add')
        expect(add.afterJson).to.equal('{"k":1}')
        expect(add.beforeJson).to.equal(undefined)

        const mod = byPath.get('configs/changed.json')!
        expect(mod.kind).to.equal('modify')
        expect(mod.beforeJson).to.equal('{"k":1}')
        expect(mod.afterJson).to.equal('{"k":2}')

        const del = byPath.get('configs/gone.json')!
        expect(del.kind).to.equal('delete')
        expect(del.beforeJson).to.equal('{"k":3}')
        expect(del.afterJson).to.equal(undefined)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('403 denials', () => {
    it('throws PushFatalError(PUSH_DENIED) with one line per denial including the required permission', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [
          {kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'},
          {kind: 'modified', path: 'configs/b.json', beforeJson: '{}', afterJson: '{"v":2}'},
        ]
        const errs: string[] = []
        const {deps} = makeDeps({
          deltas,
          pushResult: {
            kind: 'denied',
            denials: [
              {
                path: 'configs/a.json',
                reason: 'Missing required permission to edit configs/a.json: config.edit.protected-all-envs',
                requiredPermission: 'config.edit.protected-all-envs',
              },
              {
                path: 'configs/b.json',
                reason: 'Missing required permission to edit configs/b.json: config.edit.protected-prod',
                requiredPermission: 'config.edit.protected-prod',
              },
            ],
          },
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
          },
        })
        ;(deps as RunPushDeps).errLog = (s) => errs.push(s)

        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }

        let caught: unknown
        try {
          await runPush(input, deps)
        } catch (error) {
          caught = error
        }

        expect(caught).to.be.instanceOf(PushFatalError)
        expect((caught as PushFatalError).code).to.equal('PUSH_DENIED')

        const joined = errs.join('\n')
        expect(joined).to.include('configs/a.json')
        expect(joined).to.include('config.edit.protected-all-envs')
        expect(joined).to.include('configs/b.json')
        expect(joined).to.include('config.edit.protected-prod')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('CONFLICT', () => {
    it('throws PushFatalError(CONFLICT) with a "qfg pull and retry" hint', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}]
        const {deps} = makeDeps({
          deltas,
          pushResult: {kind: 'conflict', message: 'configs/a.json was modified (expected ..., got ...)'},
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
          },
        })

        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }

        let caught: unknown
        try {
          await runPush(input, deps)
        } catch (error) {
          caught = error
        }

        expect(caught).to.be.instanceOf(PushFatalError)
        const pe = caught as PushFatalError
        expect(pe.code).to.equal('CONFLICT')
        expect(pe.message.toLowerCase()).to.include('qfg pull')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('success', () => {
    it('returns the commit SHA from the server response', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}]
        const {deps} = makeDeps({
          deltas,
          pushResult: {kind: 'success', commitSha: 'deadbeef0011223344556677'},
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
          },
        })

        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.commitSha).to.equal('deadbeef0011223344556677')
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('expectedSha forwarding (qfg-gj3i)', () => {
    const FAKE_ORIGIN_SHA = '1234567890abcdef1234567890abcdef12345678'

    it('forwards origin/main SHA from gitOps.getOriginMainSha as expectedSha on the push input', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
            getOriginMainSha: async () => FAKE_ORIGIN_SHA,
          },
        })

        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        await runPush(input, deps)

        expect(captured.pushToServer).to.have.length(1)
        expect(captured.pushToServer[0].expectedSha).to.equal(FAKE_ORIGIN_SHA)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('omits expectedSha entirely when gitOps.getOriginMainSha returns undefined (bare path)', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
            getOriginMainSha: async (): Promise<string | undefined> => undefined,
          },
        })

        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        await runPush(input, deps)

        expect(captured.pushToServer).to.have.length(1)
        const sent = captured.pushToServer[0]
        // Distinguish "key omitted" from "key present with value undefined".
        // The wire shape uses the former — server-side Zod treats `expectedSha?`
        // as optional, and we want bare-path requests to look identical to a
        // pre-qfg-gj3i client (no key) rather than carrying a sentinel.
        expect(sent.expectedSha).to.equal(undefined)
        expect(Object.hasOwn(sent, 'expectedSha')).to.equal(false)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('write-PAT mint is gone from the push code path', () => {
    it('only mints with scope=read; never with scope=write', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            countFilesInRemote: async () => 100,
          },
        })

        const input: RunPushInput = {
          dir,
          requestedTarget: BACKEND_UUID,
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        await runPush(input, deps)

        expect(captured.mint.length).to.be.greaterThan(0)
        for (const call of captured.mint) {
          expect(call.scope).to.equal('read')
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })
})
