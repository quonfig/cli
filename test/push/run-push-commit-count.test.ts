/**
 * qfg-5bjew.24: the "Pushed N commit(s)" line after a pack push.
 *
 * A brand-new branch has no remote ref, so the old count ran
 * `git rev-list --count HEAD` and counted all of main's history (one new
 * commit printed "Pushed 17 commit(s)"). A branch push now counts only the
 * commits that are on neither the remote branch nor origin/main. A main push
 * counts `<origin/main>..HEAD` exactly as before.
 *
 * These tests drive runPush against a real git repo and the real
 * `countCommitsBetween` from commands/push.ts, so the printed number is what
 * `git rev-list` actually returns.
 */

import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

import type Push from '../../src/commands/push.js'

import {buildRealDeps} from '../../src/commands/push.js'
import type {CurrentBranchResult} from '../../src/push/git-pack.js'
import {runPush, type GitOps, type GiteaTokenMintResult, type RunPushDeps} from '../../src/push/run-push.js'

const BACKEND_UUID = '00000000-0000-4000-8000-000000000001'
const BACKEND: GiteaTokenMintResult = {
  token: 'fake-read-token',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
  expiresAt: null,
  workspaceSlug: 'acme-prod',
  workspaceId: BACKEND_UUID,
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Count Test',
  GIT_AUTHOR_EMAIL: 'count@test.quonfig',
  GIT_COMMITTER_NAME: 'Count Test',
  GIT_COMMITTER_EMAIL: 'count@test.quonfig',
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', env: GIT_ENV}).trim()
}

function commit(dir: string, n: number, label: string): void {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `${label}-${i}.txt`), `${label} ${i}\n`)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', `${label} ${i}`)
  }
}

function newRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-count-')))
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  return dir
}

const stubCmd = {log() {}, logToStderr() {}} as unknown as Push

function makeDeps(opts: {
  branch: string
  dir: string
  originMain: string
  remoteBranchSha?: string
  countCalls?: unknown[][]
}): {deps: RunPushDeps; logs: string[]} {
  const logs: string[] = []
  const real = buildRealDeps(stubCmd, 'acme').deps.gitOps
  const branch: CurrentBranchResult = {kind: 'branch', name: opts.branch}
  const gitOps: GitOps = {
    isGitRepo: async () => true,
    getRemoteOriginUrl: async () => BACKEND.repoUrl,
    getAllRemoteUrls: async () => [BACKEND.repoUrl],
    async setRemoteOrigin() {},
    async fetch() {},
    diffHeadVsOrigin: async () => [{kind: 'modified', path: 'configs/a.json', beforeJson: '{}', afterJson: '{"v":1}'}],
    countFilesInRemote: async () => 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async () => opts.originMain,
    getCurrentBranch: async () => branch,
    getHeadSha: async () => git(opts.dir, 'rev-parse', 'HEAD'),
    getRemoteBranchSha: async () => opts.remoteBranchSha,
    buildPack: async () => Uint8Array.from([1, 2, 3]),
    async countCommitsBetween(...args: Parameters<GitOps['countCommitsBetween']>) {
      opts.countCalls?.push(args)
      return real.countCommitsBetween(...args)
    },
    getCommitOneline: async () => '',
    getTreeShaForRef: async () => 'a'.repeat(40),
  }
  const confirmIO = {input: new PassThrough(), output: new PassThrough()}
  setImmediate(() => confirmIO.input.end())
  const deps: RunPushDeps = {
    mintWriteToken: async () => BACKEND,
    validate: async () => ({errors: []}),
    gitOps,
    pushToServer: async () => ({kind: 'success', commitSha: 'abc'}),
    pushPackToServer: async (sent) => ({kind: 'success', commitSha: sent.newSha, ref: sent.targetRef}),
    confirmIO,
    log: (l) => logs.push(l),
    errLog() {},
  }
  return {deps, logs}
}

const input = (dir: string) => ({dir, requestedTarget: BACKEND_UUID, yes: true, skipValidate: true, noPinWrite: true})

const pushedLine = (logs: string[]) => logs.find((l) => l.startsWith('Pushed '))

describe('runPush commit count (qfg-5bjew.24)', () => {
  it('counts only the new commit on a brand-new branch, not main history', async () => {
    const dir = newRepo()
    try {
      commit(dir, 15, 'main')
      const originMain = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'switch', '-q', '-c', 'cr-new')
      commit(dir, 1, 'branch')
      const head = git(dir, 'rev-parse', 'HEAD')

      const {deps, logs} = makeDeps({branch: 'cr-new', dir, originMain})
      await runPush(input(dir), deps)
      expect(pushedLine(logs)).to.equal(
        `Pushed 1 commit(s) to origin/refs/heads/cr-new as ${head.slice(0, 7)}. Local repo in sync.`,
      )
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('leaves out main commits merged into an existing branch', async () => {
    const dir = newRepo()
    try {
      commit(dir, 3, 'main')
      git(dir, 'switch', '-q', '-c', 'cr-old')
      commit(dir, 1, 'branch-a')
      const remoteBranchSha = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'switch', '-q', 'main')
      commit(dir, 4, 'main-later')
      const originMain = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'switch', '-q', 'cr-old')
      git(dir, 'merge', '-q', '--no-edit', 'main')
      commit(dir, 1, 'branch-b')

      const {deps, logs} = makeDeps({branch: 'cr-old', dir, originMain, remoteBranchSha})
      await runPush(input(dir), deps)
      // The merge commit and branch-b; main-later's 4 commits are already on the server.
      expect(pushedLine(logs)).to.match(/^Pushed 2 commit\(s\) to origin\/refs\/heads\/cr-old /)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('counts a main push as origin/main..HEAD, exactly as before', async () => {
    const dir = newRepo()
    try {
      commit(dir, 10, 'main')
      const originMain = git(dir, 'rev-parse', 'HEAD')
      commit(dir, 2, 'local')
      const head = git(dir, 'rev-parse', 'HEAD')

      const countCalls: unknown[][] = []
      const {deps, logs} = makeDeps({branch: 'main', dir, originMain, countCalls})
      await runPush(input(dir), deps)
      expect(pushedLine(logs)).to.equal(
        `Pushed 2 commit(s) to origin/refs/heads/main as ${head.slice(0, 7)}. Local repo in sync.`,
      )
      expect(countCalls).to.deep.equal([[dir, originMain, head]])
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})
