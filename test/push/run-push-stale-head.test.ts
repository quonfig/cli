/**
 * Regression tests for qfg-fboj — the silent-data-loss bug surfaced by
 * Persona C. The clone path used to ship a push when local HEAD was
 * behind origin/main, which "modified" the newer remote files BACK to
 * local-HEAD content (silently reverting the UI's most recent saves).
 * It also silently dropped any working-tree edits the user hadn't
 * committed.
 *
 * The fix:
 *   1. Refuse the push when local HEAD is strictly behind origin/main
 *      (or has diverged). Tell the user to run `qfg pull` first.
 *   2. Warn loudly about dirty tracked files (other than the workspace
 *      pin handled by commitPinFixIfPinOnly) so the user knows their
 *      uncommitted edits were NOT included in the push.
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
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-stale-')))
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
  pushToServer: ConfigPushInput[]
  logs: string[]
  errs: string[]
}

function makeDeps(opts: {
  deltas: FileDelta[]
  pushResult?: ConfigPushResult
  gitOps?: Partial<GitOps>
  userInput?: string
}): {deps: RunPushDeps; captured: Captured} {
  const captured: Captured = {pushToServer: [], logs: [], errs: []}

  const gitOps: GitOps = {
    isGitRepo: async () => true,
    getRemoteOriginUrl: async () => BACKEND.repoUrl,
    async setRemoteOrigin() {},
    async fetch() {},
    diffHeadVsOrigin: async () => opts.deltas,
    countFilesInRemote: async () => 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async () => undefined,
    ...opts.gitOps,
  }

  const deps: RunPushDeps = {
    async mintWriteToken() {
      return BACKEND
    },
    async validate() {
      return {errors: []}
    },
    gitOps,
    async pushToServer(input) {
      captured.pushToServer.push(input)
      return opts.pushResult ?? {kind: 'success', commitSha: 'abc1234567890def'}
    },
    confirmIO: makeIo(opts.userInput),
    log: (s) => captured.logs.push(s),
    errLog: (s) => captured.errs.push(s),
  }

  return {deps, captured}
}

function baseInput(dir: string): RunPushInput {
  return {
    dir,
    requestedTarget: BACKEND_UUID,
    yes: true,
    skipValidate: true,
    noPinWrite: true,
  }
}

describe('runPush stale-HEAD guard (qfg-fboj)', () => {
  describe('local HEAD behind origin/main', () => {
    it('refuses the push and never calls pushToServer when local HEAD is behind', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [
          {
            kind: 'modified',
            path: 'feature-flags/may2.merge.beta.json',
            beforeJson: JSON.stringify({value: 'ui-v2'}),
            afterJson: JSON.stringify({value: 'ui-v1'}),
          },
        ]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            isLocalBehindRemote: async () => true,
          },
        })

        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }

        expect(caught, 'expected PushFatalError, got nothing').to.be.instanceOf(PushFatalError)
        const pe = caught as PushFatalError
        expect(pe.code).to.equal('STALE_HEAD')
        expect(pe.message.toLowerCase()).to.include('qfg pull')
        expect(captured.pushToServer, 'pushToServer must not be called when local HEAD is stale').to.have.length(0)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does NOT run the stale-HEAD guard on the bare path (no .git dir)', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [
          {kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'},
        ]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            isGitRepo: async () => false,
            getRemoteOriginUrl: async () => undefined,
            isLocalBehindRemote: async () => true,
          },
        })

        const result = await runPush(baseInput(dir), deps)
        expect(result.kind).to.equal('pushed')
        expect(captured.pushToServer).to.have.length(1)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('dirty working tree on clone path', () => {
    it('logs a clear warning about each dirty tracked file before sending the push', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [
          {kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'},
        ]
        const {deps, captured} = makeDeps({
          deltas,
          gitOps: {
            dirtyTrackedFiles: async () => ['feature-flags/may2.merge.alpha.json'],
          },
        })

        const result = await runPush(baseInput(dir), deps)
        expect(result.kind).to.equal('pushed')

        const joined = captured.logs.join('\n')
        expect(joined).to.include('feature-flags/may2.merge.alpha.json')
        expect(joined.toLowerCase()).to.include('uncommitted')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })
})
