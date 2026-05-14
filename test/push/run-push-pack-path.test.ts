/**
 * runPush dispatch tests for the new pack-push clone-path flow
 * (qfg-7429.4, §4.1 of project/plans/qfg-git-commit-push-pull-improvements.md).
 *
 * The clone path used to ship file-deltas via `configs.push`. With this
 * bead it ships an actual git packfile via `configs.gitPush`, refusing
 * detached HEAD / `master` up front and running `git fetch origin`
 * post-push to bring the remote-tracking ref in line with the SHA the
 * server published. The bare-path (no `.git`) flow is unchanged.
 *
 * Assertions:
 *   - HEAD on `main` → `targetRef = refs/heads/main`, pack shipped via
 *     gitPush, post-push fetch invoked, success log printed.
 *   - HEAD on `feature-x` → `targetRef = refs/heads/feature-x`,
 *     `expectedSha = origin/feature-x` if known, else zero-OID.
 *   - Detached HEAD → PushFatalError with the §4.1-step-1 message.
 *   - master → PushFatalError with the rename suggestion.
 *   - 403 denied → one error line per denial naming commit + permission.
 *   - 409 conflict → PushFatalError with the qfg-pull rebase hint.
 *   - No `.git/` (bare-path) → falls back to existing configs.push flow.
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
  type GitPushInput,
  type GitPushResult,
  type GiteaTokenMintResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'
import {FileDelta} from '../../src/push/diff-summary.js'
import type {CurrentBranchResult} from '../../src/push/git-pack.js'

const BACKEND_UUID = '00000000-0000-4000-8000-000000000001'

const BACKEND: GiteaTokenMintResult = {
  token: 'fake-read-token',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
  expiresAt: null,
  workspaceSlug: 'acme-prod',
  workspaceId: BACKEND_UUID,
}

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-pack-')))
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
  errs: string[]
  fetchAfterPushDirs: string[]
  logs: string[]
  pushPack: GitPushInput[]
  pushToServer: ConfigPushInput[]
}

const FAKE_NEW_SHA = '1111111111111111111111111111111111111111'
const FAKE_EXPECTED_SHA = '2222222222222222222222222222222222222222'
const FAKE_PACK = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])

function makeDeps(opts: {
  deltas?: FileDelta[]
  branch?: CurrentBranchResult
  newSha?: string
  expectedSha?: string
  remoteBranchSha?: string | undefined
  packResult?: GitPushResult
  packThrows?: Error
  pushResult?: ConfigPushResult
  gitOps?: Partial<GitOps>
  userInput?: string
}): {deps: RunPushDeps; captured: Captured} {
  const captured: Captured = {pushPack: [], pushToServer: [], fetchAfterPushDirs: [], logs: [], errs: []}
  const branch: CurrentBranchResult = opts.branch ?? {kind: 'branch', name: 'main'}

  // Default to clone-path: isGitRepo true, origin matches backend.
  let fetchCount = 0
  const gitOps: GitOps = {
    isGitRepo: async () => true,
    getRemoteOriginUrl: async () => BACKEND.repoUrl,
    getAllRemoteUrls: async () => [BACKEND.repoUrl],
    async setRemoteOrigin() {},
    async fetch(dir: string) {
      // First fetch is the pre-push fetch in clone-path. Subsequent
      // fetches are the post-push refresh that pack-push runs to align
      // the remote-tracking ref. We capture the post-push call to assert
      // it ran on success.
      fetchCount += 1
      if (fetchCount > 1) captured.fetchAfterPushDirs.push(dir)
    },
    diffHeadVsOrigin: async () =>
      opts.deltas ?? [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}],
    countFilesInRemote: async () => 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async () => opts.expectedSha ?? FAKE_EXPECTED_SHA,
    getCurrentBranch: async () => branch,
    getHeadSha: async () => opts.newSha ?? FAKE_NEW_SHA,
    getRemoteBranchSha: async () => opts.remoteBranchSha,
    buildPack: async () => FAKE_PACK,
    countCommitsBetween: async () => 1,
    getCommitOneline: async (_dir, sha) => `${sha.slice(0, 7)} (stub) commit message`,
    // Default: HEAD tree and origin tree DIFFER, so a 409 conflict falls
    // through to the real-conflict path (the qfg-7429.6 legacy-divergence
    // detector requires identical trees to trigger the migration hint).
    getTreeShaForRef: async (_dir, ref) =>
      ref === 'HEAD' ? 'aaaa000000000000000000000000000000000000' : 'bbbb000000000000000000000000000000000000',
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
    async pushPackToServer(input) {
      captured.pushPack.push(input)
      if (opts.packThrows) throw opts.packThrows
      return (
        opts.packResult ?? {
          kind: 'success',
          commitSha: input.newSha,
          ref: input.targetRef,
        }
      )
    },
    confirmIO: makeIo(opts.userInput),
    log(line) {
      captured.logs.push(line)
    },
    errLog(line) {
      captured.errs.push(line)
    },
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

function setUpDir(): string {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
  return dir
}

describe('runPush pack-push dispatch (qfg-7429.4)', () => {
  describe('main branch happy path', () => {
    it('builds a pack of expectedSha..newSha, ships via gitPush, runs post-push fetch, prints final log', async () => {
      const dir = setUpDir()
      try {
        const newSha = 'abcdef0011223344556677889900aabbccddeeff'
        const expectedSha = '00112233445566778899aabbccddeeff00112233'
        const {deps, captured} = makeDeps({newSha, expectedSha})
        const result = await runPush(baseInput(dir), deps)

        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.dispatchedAs).to.equal('clone-path')
          expect(result.commitSha).to.equal(newSha)
        }

        expect(captured.pushPack).to.have.length(1)
        const sent = captured.pushPack[0]
        expect(sent.workspaceId).to.equal(BACKEND_UUID)
        expect(sent.targetRef).to.equal('refs/heads/main')
        expect(sent.expectedSha).to.equal(expectedSha)
        expect(sent.newSha).to.equal(newSha)
        expect(sent.pack).to.equal(FAKE_PACK)

        // Post-push fetch must run so the local origin/main tracking ref
        // catches up to the SHA the server published (the bead's "git
        // fetch origin (NOT git reset)" requirement).
        expect(captured.fetchAfterPushDirs).to.deep.equal([dir])

        // Final log line shape from the bead description.
        const finalLog = captured.logs.find((l) => l.includes('Local repo in sync'))
        expect(finalLog, captured.logs.join('\n')).to.exist
        expect(finalLog).to.match(
          /Pushed \d+ commit\(s\) to origin\/refs\/heads\/main as [\da-f]{7,}\. Local repo in sync\./,
        )
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does not call the configs.push (bare-path) handler when pack-push is dispatched', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({})
        await runPush(baseInput(dir), deps)
        expect(captured.pushToServer).to.have.length(0)
        expect(captured.pushPack).to.have.length(1)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('non-main branch', () => {
    it('targets refs/heads/<branch> and uses origin/<branch> as expectedSha when present', async () => {
      const dir = setUpDir()
      try {
        const remoteBranchSha = 'cafe11111111111111111111111111111111cafe'
        const {deps, captured} = makeDeps({
          branch: {kind: 'branch', name: 'feature/awesome'},
          remoteBranchSha,
        })
        await runPush(baseInput(dir), deps)
        expect(captured.pushPack).to.have.length(1)
        expect(captured.pushPack[0].targetRef).to.equal('refs/heads/feature/awesome')
        expect(captured.pushPack[0].expectedSha).to.equal(remoteBranchSha)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('uses zero-OID as expectedSha when origin has no tracking ref for this branch', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          branch: {kind: 'branch', name: 'feature/brand-new'},
          remoteBranchSha: undefined,
        })
        await runPush(baseInput(dir), deps)
        expect(captured.pushPack).to.have.length(1)
        expect(captured.pushPack[0].targetRef).to.equal('refs/heads/feature/brand-new')
        expect(captured.pushPack[0].expectedSha).to.equal('0000000000000000000000000000000000000000')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('preflight refusals', () => {
    it('refuses detached HEAD with the §4.1-step-1 message and never calls pushPackToServer', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          branch: {kind: 'detached', message: 'qfg push requires a checked-out branch.'},
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        expect((caught as PushFatalError).message).to.include('qfg push requires a checked-out branch.')
        expect(captured.pushPack).to.have.length(0)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('refuses master with the rename suggestion and never calls pushPackToServer', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          branch: {
            kind: 'master',
            message: 'Quonfig workspaces use `main`; rename with `git branch -m master main`.',
          },
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        expect((caught as PushFatalError).message).to.include('Quonfig workspaces use `main`')
        expect((caught as PushFatalError).message).to.include('git branch -m master main')
        expect(captured.pushPack).to.have.length(0)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('failure modes', () => {
    it('maps 403 denied to PushFatalError(PUSH_DENIED) with one error line per denial (sha + path + reason + perm)', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          packResult: {
            kind: 'denied',
            denials: [
              {
                commitSha: 'deadbeefcafebabe0000000000000000abcdef00',
                path: 'configs/secret.json',
                reason: 'missing-permission',
                requiredPermission: 'config.edit.protected-all-envs',
              },
            ],
          },
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        expect((caught as PushFatalError).code).to.equal('PUSH_DENIED')
        const joined = captured.errs.join('\n')
        // qfg-7429.5 format: `<short-sha>  <path>  -- <reason>, requires <requiredPermission>`
        expect(joined).to.include('configs/secret.json')
        expect(joined).to.include('config.edit.protected-all-envs')
        expect(joined).to.include('deadbeef') // short SHA
        expect(joined).to.include('missing-permission') // reason
        expect(joined).to.match(/requires\s+config\.edit\.protected-all-envs/)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('prints suggestedRecovery verbatim + offending commit oneline when the server attaches one (qfg-7429.5, §6)', async () => {
      const dir = setUpDir()
      try {
        const offendingSha = 'feedbeefdeadbabe1111111111111111feed1234'
        const recoveryMessage =
          'This commit was likely merged on your upstream remote without Quonfig review. Revert it there, re-pull, then qfg push again. Alternatively, ask a workspace admin with the listed permission to push this change.'
        const onelineCalls: string[] = []
        const {deps, captured} = makeDeps({
          gitOps: {
            async getCommitOneline(_dir, sha) {
              onelineCalls.push(sha)
              return `${sha.slice(0, 7)} feat: merge Bob's protected change`
            },
          },
          packResult: {
            kind: 'denied',
            denials: [
              {
                commitSha: offendingSha,
                path: 'protected-all-envs/auth.signing-key.json',
                reason: 'missing-permission',
                requiredPermission: 'config.edit.protected',
              },
            ],
            suggestedRecovery: {
              kind: 'revert-upstream',
              offendingCommitSha: offendingSha,
              message: recoveryMessage,
            },
          },
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        const joined = captured.errs.join('\n')
        // Verbatim message from the server.
        expect(joined).to.include(recoveryMessage)
        // Offending commit's oneline came from `git log -1 --pretty=oneline`.
        expect(onelineCalls).to.deep.equal([offendingSha])
        expect(joined).to.include(`${offendingSha.slice(0, 7)} feat: merge Bob's protected change`)
        // Admin-escalation alternative is part of the verbatim message
        // (covered by the server emitting it). We assert it lands in
        // the stderr stream so the CLI didn't strip it.
        expect(joined.toLowerCase()).to.include('admin')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does NOT print a recovery hint when the server omits suggestedRecovery (qfg-7429.5)', async () => {
      const dir = setUpDir()
      try {
        const onelineCalls: string[] = []
        const {deps, captured} = makeDeps({
          gitOps: {
            async getCommitOneline(_dir, sha) {
              onelineCalls.push(sha)
              return 'should-never-be-called'
            },
          },
          packResult: {
            kind: 'denied',
            denials: [
              {
                commitSha: 'deadbeefcafebabe0000000000000000abcdef00',
                path: 'configs/secret.json',
                reason: 'missing-permission',
                requiredPermission: 'config.edit.protected-all-envs',
              },
            ],
            // no suggestedRecovery
          },
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        const joined = captured.errs.join('\n')
        // No upstream-revert language.
        expect(joined.toLowerCase()).to.not.include('upstream')
        expect(joined.toLowerCase()).to.not.include('revert')
        // And no oneline lookup happened.
        expect(onelineCalls).to.have.length(0)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('sends hasUpstreamRemote=true when any remote URL does not match the backend repo (qfg-7429.5)', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          gitOps: {
            getAllRemoteUrls: async () => [BACKEND.repoUrl, 'https://github.com/acme/config'],
          },
        })
        await runPush(baseInput(dir), deps)
        expect(captured.pushPack).to.have.length(1)
        expect(captured.pushPack[0].hasUpstreamRemote).to.equal(true)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('sends hasUpstreamRemote=false when every remote URL matches the backend repo (qfg-7429.5)', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          gitOps: {
            getAllRemoteUrls: async () => [BACKEND.repoUrl],
          },
        })
        await runPush(baseInput(dir), deps)
        expect(captured.pushPack).to.have.length(1)
        expect(captured.pushPack[0].hasUpstreamRemote).to.equal(false)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('maps 409 conflict to PushFatalError(CONFLICT) with a qfg-pull hint', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          packResult: {kind: 'conflict', message: 'OriginMoved: expected ..., current ...'},
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        expect((caught as PushFatalError).code).to.equal('CONFLICT')
        expect((caught as PushFatalError).message.toLowerCase()).to.include('qfg pull')
        // qfg-7429.6: trees differ → must NOT print the legacy-divergence
        // migration hint or recommend a hard reset.
        const joined = [...captured.errs, ...captured.logs].join('\n')
        expect(joined).to.not.include('git reset --hard origin/main')
        expect(joined.toLowerCase()).to.not.include('fabricate-commit')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('prints the legacy-divergence migration hint when conflict + HEAD tree matches origin tree (qfg-7429.6)', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          packResult: {kind: 'conflict', message: 'OriginMoved: expected ..., current ...'},
          gitOps: {
            // HEAD tree == origin/main tree → legacy orphan-commit state
            // left behind by the fabricate-commit handler.
            getTreeShaForRef: async () => 'cafe000000000000000000000000000000000000',
          },
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        const joined = captured.errs.join('\n')
        // The one-shot migration hint must be the suggested remedy.
        expect(joined).to.include('git reset --hard origin/main')
        expect(joined.toLowerCase()).to.include('fabricate-commit')
        expect(joined.toLowerCase()).to.include('one-time cutover')
        // Per the bead description: NOT qfg pull --rebase — rebase would
        // produce phantom replay commits with new SHAs forever.
        expect(joined.toLowerCase()).to.not.include('qfg pull')
        expect(joined.toLowerCase()).to.not.include('rebase')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('uses the branch-specific reset hint on a non-main branch (qfg-7429.6)', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          branch: {kind: 'branch', name: 'feature/awesome'},
          remoteBranchSha: 'cafe11111111111111111111111111111111cafe',
          packResult: {kind: 'conflict', message: 'OriginMoved: ...'},
          gitOps: {
            getTreeShaForRef: async () => 'beef000000000000000000000000000000000000',
          },
        })
        let caught: unknown
        try {
          await runPush(baseInput(dir), deps)
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(PushFatalError)
        const joined = captured.errs.join('\n')
        expect(joined).to.include('git reset --hard origin/feature/awesome')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('bare-path fallback', () => {
    it('uses the existing configs.push wire when the dir has no .git/', async () => {
      const dir = setUpDir()
      try {
        const {deps, captured} = makeDeps({
          gitOps: {
            isGitRepo: async () => false,
            getRemoteOriginUrl: async (): Promise<string | undefined> => undefined,
            getAllRemoteUrls: async (): Promise<string[]> => [],
          },
        })
        const result = await runPush(baseInput(dir), deps)
        expect(result.kind).to.equal('pushed')
        if (result.kind === 'pushed') {
          expect(result.dispatchedAs).to.equal('bare-path')
        }
        expect(captured.pushToServer).to.have.length(1)
        expect(captured.pushPack).to.have.length(0)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })
})
