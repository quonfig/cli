/**
 * Regression tests for qfg-3uks Item B — `qfg push --no-interactive` used to
 * fall through to `confirmYesNo`, which immediately resolved `false` against a
 * non-TTY stdin and produced the misleading "Aborted: user declined at
 * confirm prompt" message.
 *
 * After the fix, `runPush` honours an explicit `interactive: false` input:
 *   - For a normal Y/N confirm, refuse with a message that points the user at
 *     `--yes` (matches the `qfg delete` pattern).
 *   - For destructive (typed-slug) confirms, refuse with a message explaining
 *     that destructive pushes always require an interactive typed-slug
 *     prompt — `--yes` does not bypass that one.
 *   - When `--yes` is passed alongside `--no-interactive`, the standard Y/N is
 *     skipped and the push proceeds.
 */

import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
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
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-no-int-')))
}

function makeDeps(opts: {
  deltas: FileDelta[]
  pushResult?: ConfigPushResult
  gitOps?: Partial<GitOps>
  totalFilesInRemote?: number
}): {deps: RunPushDeps; pushed: ConfigPushInput[]; packPushed: number} {
  const pushed: ConfigPushInput[] = []
  // qfg-7429.4: clone-path now ships via pack-push. Tests that drive
  // the dispatch should look at packPushed (count of gitPush calls)
  // rather than `pushed` for clone-path scenarios.
  let packPushed = 0

  const gitOps: GitOps = {
    isGitRepo: async () => true,
    getRemoteOriginUrl: async () => BACKEND.repoUrl,
    getAllRemoteUrls: async () => [BACKEND.repoUrl],
    async setRemoteOrigin() {},
    async fetch() {},
    diffHeadVsOrigin: async () => opts.deltas,
    countFilesInRemote: async () => opts.totalFilesInRemote ?? 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async (): Promise<string | undefined> => undefined,
    // Pack-push (qfg-7429.4) stubs — this file tests confirmation-prompt
    // behavior, which fires before either push branch. Provide defaults
    // so the type-check is satisfied and a non-aborting test path can
    // still reach the dispatch.
    getCurrentBranch: async () => ({kind: 'branch', name: 'main'}),
    getHeadSha: async () => '0000000000000000000000000000000000000000',
    getRemoteBranchSha: async (): Promise<string | undefined> => undefined,
    buildPack: async () => new Uint8Array(0),
    countCommitsBetween: async () => 0,
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
      pushed.push(input)
      return opts.pushResult ?? {kind: 'success', commitSha: 'abc123'}
    },
    async pushPackToServer(input) {
      // Pack-push success stub (qfg-7429.4). The --no-interactive tests
      // mostly abort at the confirm step, but the dispatch is wired up
      // when they don't.
      packPushed += 1
      return {kind: 'success', commitSha: input.newSha, ref: input.targetRef}
    },
    log() {},
    errLog() {},
  }

  return {
    deps,
    pushed,
    get packPushed() {
      return packPushed
    },
  }
}

describe('runPush --no-interactive (qfg-3uks Item B)', () => {
  it('aborts with a clear --yes message when interactive=false and yes=false (non-destructive Y/N path)', async () => {
    const dir = tmpDir()
    try {
      fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
      const deltas: FileDelta[] = [
        {kind: 'modified', path: 'configs/a.json', beforeJson: '{"v":1}', afterJson: '{"v":2}'},
      ]
      const {deps, pushed} = makeDeps({deltas})

      const input: RunPushInput = {
        dir,
        requestedTarget: BACKEND_UUID,
        yes: false,
        interactive: false,
        skipValidate: true,
        noPinWrite: true,
      }

      const result = await runPush(input, deps)

      expect(result.kind).to.equal('aborted')
      if (result.kind !== 'aborted') return
      expect(result.reason).to.match(/--no-interactive/)
      expect(result.reason).to.match(/--yes/)
      expect(pushed).to.have.length(0)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('aborts with a destructive-needs-interactive message when interactive=false and the diff is destructive (yes does not bypass typed-slug)', async () => {
    const dir = tmpDir()
    try {
      fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
      // A diff with 12 deletes against a 100-file remote → destructive
      // (>=10 deletes), which forces a typed-slug confirmation.
      const deltas: FileDelta[] = Array.from({length: 12}, (_, i) => ({
        kind: 'deleted' as const,
        path: `configs/d-${i}.json`,
        beforeJson: '{}',
      }))
      const {deps, pushed} = makeDeps({deltas, totalFilesInRemote: 100})

      const input: RunPushInput = {
        dir,
        requestedTarget: BACKEND_UUID,
        yes: true,
        interactive: false,
        skipValidate: true,
        noPinWrite: true,
      }

      const result = await runPush(input, deps)

      expect(result.kind).to.equal('aborted')
      if (result.kind !== 'aborted') return
      expect(result.reason.toLowerCase()).to.include('destructive')
      expect(result.reason).to.match(/typed[ -]slug/i)
      expect(pushed).to.have.length(0)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('proceeds when --no-interactive is combined with --yes for a non-destructive push', async () => {
    const dir = tmpDir()
    try {
      fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
      const deltas: FileDelta[] = [
        {kind: 'modified', path: 'configs/a.json', beforeJson: '{"v":1}', afterJson: '{"v":2}'},
      ]
      const captured = makeDeps({deltas})

      const input: RunPushInput = {
        dir,
        requestedTarget: BACKEND_UUID,
        yes: true,
        interactive: false,
        skipValidate: true,
        noPinWrite: true,
      }

      const result = await runPush(input, captured.deps)

      expect(result.kind).to.equal('pushed')
      // qfg-7429.4: clone-path now ships via the pack-push wire.
      expect(captured.packPushed).to.equal(1)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})
