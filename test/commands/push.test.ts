import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

import {
  PushFatalError,
  runPush,
  withPushedViaTrailer,
  type ConfigPushInput,
  type ConfigPushResult,
  type GitOps,
  type GiteaTokenMintResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'
import {FileDelta} from '../../src/push/diff-summary.js'
import {giteaResponseToMintResult} from '../../src/commands/push.js'
import type {GiteaTokenResponse} from '../../src/util/gitea-api.js'

/**
 * Unit tests for `runPush` — the dependency-injected core of the `qfg push`
 * command. These tests mock out the token mint, git ops, validation, and file
 * mirroring so we can exercise the branching logic without a real network or
 * git binary.
 *
 * Integration coverage against a live bare repo lives in a separate task.
 */

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-')))
}

const BACKEND: GiteaTokenMintResult = {
  token: 'fake-token',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
  expiresAt: null,
  workspaceSlug: 'acme-prod',
  workspaceId: 'acme-prod',
}

type MintCall = {requestedTarget: string}

type CapturedCalls = {
  mint: MintCall[]
  validate: string[]
  pushToServer: ConfigPushInput[]
  setRemoteOrigin: Array<[string, string]>
}

function makeDeps(
  opts: {
    gitOps?: Partial<GitOps>
    token?: GiteaTokenMintResult
    mintThrows?: Error
    validateErrors?: string[]
    userInput?: string
    pushResult?: ConfigPushResult
    pushThrows?: Error
  } = {},
): {deps: RunPushDeps; calls: CapturedCalls; logs: string[]; errs: string[]} {
  const calls: CapturedCalls = {
    mint: [],
    validate: [],
    pushToServer: [],
    setRemoteOrigin: [],
  }
  const logs: string[] = []
  const errs: string[] = []

  const io = (() => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.on('data', () => {})
    if (opts.userInput === undefined) {
      setImmediate(() => {
        input.end()
      })
    } else {
      setImmediate(() => {
        input.write(opts.userInput)
        input.end()
      })
    }

    return {input, output}
  })()

  const gitOps: GitOps = {
    isGitRepo: async () => false,
    getRemoteOriginUrl: async (): Promise<string | undefined> => undefined,
    async setRemoteOrigin(dir, url) {
      calls.setRemoteOrigin.push([dir, url])
    },
    async fetch() {},
    diffHeadVsOrigin: async () => [],
    countFilesInRemote: async () => 0,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async () => undefined,
    ...opts.gitOps,
  }

  const deps: RunPushDeps = {
    async mintWriteToken(requestedTarget) {
      calls.mint.push({requestedTarget})
      if (opts.mintThrows) throw opts.mintThrows
      return opts.token ?? BACKEND
    },
    async validate(dir) {
      calls.validate.push(dir)
      return {errors: opts.validateErrors ?? []}
    },
    gitOps,
    async pushToServer(input) {
      calls.pushToServer.push(input)
      if (opts.pushThrows) throw opts.pushThrows
      return opts.pushResult ?? {kind: 'success', commitSha: 'abc1234567890def'}
    },
    confirmIO: io,
    log: (s) => logs.push(s),
    errLog: (s) => errs.push(s),
  }

  return {deps, calls, logs, errs}
}

describe('runPush (core)', () => {
  describe('input validation', () => {
    it('throws when requestedTarget is empty', async () => {
      const dir = tmpDir()
      try {
        const {deps} = makeDeps()
        const input: RunPushInput = {
          dir,
          requestedTarget: '',
          yes: false,
          skipValidate: true,
          noPinWrite: true,
        }
        try {
          await runPush(input, deps)
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(PushFatalError)
          expect((error as PushFatalError).code).to.equal('NO_TARGET')
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('throws when the dir does not exist', async () => {
      const {deps} = makeDeps()
      const input: RunPushInput = {
        dir: '/this/path/does/not/exist/ever',
        requestedTarget: 'acme-prod',
        yes: false,
        skipValidate: true,
        noPinWrite: true,
      }
      try {
        await runPush(input, deps)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(PushFatalError)
        expect((error as PushFatalError).code).to.equal('NO_DIR')
      }
    })
  })

  describe('identity check', () => {
    it('aborts with PushFatalError(IDENTITY_ABORT) when the pin disagrees with the backend', async () => {
      const dir = tmpDir()
      try {
        // Write a pin that points at a different workspace than the backend.
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'other-org/other-ws'}))

        const {deps, calls} = makeDeps()
        const input: RunPushInput = {
          dir,
          requestedTarget: 'other-ws',
          yes: true, // --yes must not rescue identity check
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

        // Should not have reached pushToServer or validate.
        expect(calls.pushToServer).to.deep.equal([])
        expect(calls.validate).to.deep.equal([])
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('validation', () => {
    it('throws PushFatalError(VALIDATION_FAILED) when validate reports errors', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const {deps, calls} = makeDeps({validateErrors: ['missing quonfig.json']})
        const input: RunPushInput = {
          dir,
          requestedTarget: 'acme-prod',
          yes: true,
          skipValidate: false,
          noPinWrite: true,
        }
        try {
          await runPush(input, deps)
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(PushFatalError)
          expect((error as PushFatalError).code).to.equal('VALIDATION_FAILED')
        }

        expect(calls.validate).to.deep.equal([dir])
        expect(calls.pushToServer).to.deep.equal([])
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('skips validate when --skip-validate is set', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const {deps, calls} = makeDeps({
          validateErrors: ['should-be-ignored'],
          userInput: 'acme-prod\n', // typed-slug confirm because unpinned? no — pinned — but no git so identity is requires-typed-slug since origin undefined but pin set => ok
          gitOps: {
            isGitRepo: async () => false,
          },
        })
        const input: RunPushInput = {
          dir,
          requestedTarget: 'acme-prod',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        // This should reach the bare path (no .git). We did not stage any
        // deltas, so the result should be a no-op (nothing to push), but
        // critically validate should not have been called.
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('no-op')
        expect(calls.validate).to.deep.equal([])
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('dispatch', () => {
    it('takes the clone path when .git exists and origin matches the backend repo URL', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/one.json'}]
        const {deps, calls} = makeDeps({
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            diffHeadVsOrigin: async () => deltas,
            countFilesInRemote: async () => 4,
          },
        })
        const input: RunPushInput = {
          dir,
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

        expect(calls.pushToServer).to.have.length(1)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('takes the bare path when .git is absent (no setRemoteOrigin call), and still calls pushToServer', async () => {
      const dir = tmpDir()
      try {
        // Pre-pin so identity passes without typed-slug.
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const {deps, calls} = makeDeps({
          gitOps: {
            isGitRepo: async () => false,
            diffHeadVsOrigin: async () => [
              {kind: 'added', path: 'configs/new.json', afterJson: '{"k":1}'},
            ],
            countFilesInRemote: async () => 4,
          },
          userInput: 'y\n',
        })
        const input: RunPushInput = {
          dir,
          requestedTarget: 'acme-prod',
          yes: false,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.dispatchedAs).to.equal('bare-path')
        }

        // Bare path never sets origin.
        expect(calls.setRemoteOrigin).to.deep.equal([])
        expect(calls.pushToServer).to.have.length(1)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('confirmation semantics', () => {
    it('--yes proceeds past a non-destructive Y/N prompt on the clone path', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = [{kind: 'modified', path: 'configs/one.json'}]
        const {deps, calls} = makeDeps({
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            diffHeadVsOrigin: async () => deltas,
            countFilesInRemote: async () => 100, // ratio small, not destructive
          },
          // No userInput — if we reached a prompt with stdin EOF, confirmYesNo
          // would return false. With --yes we should NOT reach a prompt.
        })
        const input: RunPushInput = {
          dir,
          requestedTarget: 'acme-prod',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        expect(calls.pushToServer).to.have.length(1)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('--yes does NOT skip the typed-slug prompt when the diff is destructive', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        // 12 deletes -> trips destructive (>=10 deletes)
        const deltas: FileDelta[] = []
        for (let i = 0; i < 12; i++) deltas.push({kind: 'deleted', path: `configs/gone-${i}.json`})
        const {deps, calls} = makeDeps({
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            diffHeadVsOrigin: async () => deltas,
            countFilesInRemote: async () => 100,
          },
          // No userInput — typed-slug prompt should see EOF and return false,
          // leading to an 'aborted' result. --yes should NOT rescue it.
        })
        const input: RunPushInput = {
          dir,
          requestedTarget: 'acme-prod',
          yes: true,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('aborted')
        expect(calls.pushToServer).to.deep.equal([])
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('accepts a typed slug on destructive confirmation and proceeds', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const deltas: FileDelta[] = []
        for (let i = 0; i < 12; i++) deltas.push({kind: 'deleted', path: `configs/gone-${i}.json`})
        const {deps, calls} = makeDeps({
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            diffHeadVsOrigin: async () => deltas,
            countFilesInRemote: async () => 100,
          },
          userInput: 'acme-prod\n',
        })
        const input: RunPushInput = {
          dir,
          requestedTarget: 'acme-prod',
          yes: false,
          skipValidate: true,
          noPinWrite: true,
        }
        const result = await runPush(input, deps)
        expect(result.kind).to.equal('pushed')
        expect(calls.pushToServer).to.have.length(1)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('conflict handling', () => {
    it('maps a server CONFLICT to PushFatalError(CONFLICT) with a `qfg pull` hint', async () => {
      const dir = tmpDir()
      try {
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
        const {deps} = makeDeps({
          gitOps: {
            isGitRepo: async () => true,
            getRemoteOriginUrl: async () => BACKEND.repoUrl,
            diffHeadVsOrigin: async () => [
              {kind: 'modified', path: 'configs/one.json', beforeJson: '{}', afterJson: '{"v":1}'},
            ],
            countFilesInRemote: async () => 10,
          },
          pushResult: {
            kind: 'conflict',
            message: 'configs/one.json was modified (expected ..., got ...)',
          },
        })
        const input: RunPushInput = {
          dir,
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
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('trailer', () => {
    it('withPushedViaTrailer appends "Pushed-Via: cli" when missing', () => {
      const out = withPushedViaTrailer('qfg push: 3 file change(s)')
      expect(out).to.match(/Pushed-Via: cli/)
    })

    it('withPushedViaTrailer is idempotent', () => {
      const a = withPushedViaTrailer('hello')
      const b = withPushedViaTrailer(a)
      expect(a).to.equal(b)
    })
  })
})

/**
 * Regression for qfg-gmg — staging verify hit "requested disagrees with
 * backend" when the user passed `--workspace <UUID>` because buildRealDeps
 * was setting `workspaceId: resp.workspaceSlug`. The backend now returns
 * `workspaceId` on the gitea.token response; this test locks in that the
 * CLI wiring passes the UUID through unchanged so checkIdentity's UUID
 * path works against real responses.
 */
describe('giteaResponseToMintResult (qfg-gmg regression)', () => {
  const SLUG = 'our-config-staging-test'
  const UUID = '708c30c5-ee88-4572-ac14-4c362b904b38'

  const response: GiteaTokenResponse = {
    token: 'fake-token',
    repoUrl: `https://gitea.example/${SLUG}/config.git`,
    expiresAt: null,
    workspaceSlug: SLUG,
    workspaceId: UUID,
  }

  it('passes workspaceId (UUID) through from the response — not the slug', () => {
    const mint: GiteaTokenMintResult = giteaResponseToMintResult(response)
    expect(mint.workspaceId).to.equal(UUID)
    expect(mint.workspaceId).to.not.equal(SLUG)
  })

  it('passes workspaceSlug through unchanged', () => {
    const mint: GiteaTokenMintResult = giteaResponseToMintResult(response)
    expect(mint.workspaceSlug).to.equal(SLUG)
  })

  it('preserves token / repoUrl / expiresAt verbatim', () => {
    const mint: GiteaTokenMintResult = giteaResponseToMintResult(response)
    expect(mint.token).to.equal(response.token)
    expect(mint.repoUrl).to.equal(response.repoUrl)
    expect(mint.expiresAt).to.equal(response.expiresAt)
  })
})
