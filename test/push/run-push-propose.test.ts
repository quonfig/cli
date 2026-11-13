/**
 * runPush with `--propose` (qfg-5bjew.17, change requests step 2).
 *
 * Rules under test (project/plans/2026-09-08-change-requests/review-2026-11-12/
 * 00-decisions.md):
 *   - decision 3/7: proposing is opt-in; a branch becomes a change request
 *     only on --propose. A propose push needs no --yes (nothing goes live).
 *   - rule 2.12: --propose fails unless the response carries a change-request
 *     number (an older server strips `propose` and does a plain branch push).
 *   - rule 2.11: only the clone path names --propose after a refused MAIN
 *     push; branch and bare-path denials are unchanged.
 */

import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {PassThrough} from 'node:stream'

import {
  PushFatalError,
  runPush,
  type ConfigPushResult,
  type GitOps,
  type GitPushInput,
  type GitPushResult,
  type GiteaTokenMintResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'
import type {CurrentBranchResult} from '../../src/push/git-pack.js'

const BACKEND_UUID = '00000000-0000-4000-8000-000000000001'
const APP = 'https://app.example.test'

const BACKEND: GiteaTokenMintResult = {
  token: 'fake-read-token',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
  expiresAt: null,
  workspaceSlug: 'acme-prod',
  workspaceId: BACKEND_UUID,
}

const NEW_SHA = 'abcdef0011223344556677889900aabbccddeeff'
const MAIN_SHA = '00112233445566778899aabbccddeeff00112233'
const CR_PATH = `/workspaces/${BACKEND_UUID}/change-requests/7`

interface Captured {
  confirmPrompts: number
  errs: string[]
  logs: string[]
  pushPack: GitPushInput[]
  pushToServer: number
}

function makeDeps(opts: {
  branch?: CurrentBranchResult
  isGitRepo?: boolean
  ahead?: number
  packResult?: GitPushResult
  pushResult?: ConfigPushResult
}): {deps: RunPushDeps; captured: Captured} {
  const captured: Captured = {confirmPrompts: 0, errs: [], logs: [], pushPack: [], pushToServer: 0}
  const branch: CurrentBranchResult = opts.branch ?? {kind: 'branch', name: 'cr-smoke'}
  const isGit = opts.isGitRepo ?? true

  const gitOps: GitOps = {
    isGitRepo: async () => isGit,
    getRemoteOriginUrl: async () => (isGit ? BACKEND.repoUrl : undefined),
    getAllRemoteUrls: async () => (isGit ? [BACKEND.repoUrl] : []),
    async setRemoteOrigin() {},
    async fetch() {},
    diffHeadVsOrigin: async () => [
      {kind: 'modified', path: 'feature-flags/a.json', beforeJson: '{}', afterJson: '{"v":1}'},
    ],
    countFilesInRemote: async () => 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async () => MAIN_SHA,
    getCurrentBranch: async () => branch,
    getHeadSha: async () => NEW_SHA,
    getRemoteBranchSha: async (): Promise<string | undefined> => undefined,
    buildPack: async () => Uint8Array.from([1, 2, 3]),
    async countCommitsBetween(_dir, from, to) {
      // The propose-on-main guard counts origin/main..HEAD.
      if (from === MAIN_SHA && to === NEW_SHA) return opts.ahead ?? 1
      return 1
    },
    getCommitOneline: async (_dir, sha) => `${sha.slice(0, 7)} stub`,
    getTreeShaForRef: async (_dir, ref) => (ref === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40)),
  }

  const output = new PassThrough()
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('Proceed?')) captured.confirmPrompts += 1
  })
  const input = new PassThrough()
  setImmediate(() => input.end())

  const deps: RunPushDeps = {
    mintWriteToken: async () => BACKEND,
    validate: async () => ({errors: []}),
    gitOps,
    async pushToServer() {
      captured.pushToServer += 1
      return opts.pushResult ?? {kind: 'success', commitSha: 'abc1234567890def'}
    },
    async pushPackToServer(sent) {
      captured.pushPack.push(sent)
      return opts.packResult ?? {kind: 'success', commitSha: sent.newSha, ref: sent.targetRef}
    },
    confirmIO: {input, output},
    log: (l) => captured.logs.push(l),
    errLog: (l) => captured.errs.push(l),
  }
  return {deps, captured}
}

function setUpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-propose-')))
  fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
  return dir
}

function input(dir: string, extra: Partial<RunPushInput> = {}): RunPushInput {
  return {dir, requestedTarget: BACKEND_UUID, yes: false, skipValidate: true, noPinWrite: true, ...extra}
}

async function catchFatal(p: Promise<unknown>): Promise<PushFatalError> {
  try {
    await p
  } catch (error) {
    expect(error).to.be.instanceOf(PushFatalError)
    return error as PushFatalError
  }
  throw new Error('expected a PushFatalError')
}

const OPENED: GitPushResult = {
  kind: 'success',
  commitSha: NEW_SHA,
  ref: 'refs/heads/cr-smoke',
  changeRequest: {number: 7, url: CR_PATH, status: 'open'},
}

describe('runPush --propose (qfg-5bjew.17)', () => {
  const savedApp = process.env.QUONFIG_APP_BASE_URL_OVERRIDE
  let dir: string
  beforeEach(() => {
    process.env.QUONFIG_APP_BASE_URL_OVERRIDE = APP
    dir = setUpDir()
  })
  afterEach(() => {
    if (savedApp === undefined) delete process.env.QUONFIG_APP_BASE_URL_OVERRIDE
    else process.env.QUONFIG_APP_BASE_URL_OVERRIDE = savedApp
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('T1: on a branch, sends propose, prints #n, the full URL, NOT LIVE on its own line and how to check; no prompt and no --yes', async () => {
    const {deps, captured} = makeDeps({packResult: OPENED})
    const result = await runPush(
      input(dir, {propose: {title: 'cr smoke', description: 'why'}, interactive: false}),
      deps,
    )

    expect(captured.pushPack).to.have.length(1)
    expect(captured.pushPack[0].targetRef).to.equal('refs/heads/cr-smoke')
    expect(captured.pushPack[0].propose).to.deep.equal({title: 'cr smoke', description: 'why'})
    expect(captured.confirmPrompts).to.equal(0)

    expect(result.kind).to.equal('pushed')
    if (result.kind !== 'pushed') return
    expect(result.changeRequest).to.deep.equal({number: 7, url: CR_PATH, status: 'open'})
    expect(result.branch).to.equal('cr-smoke')

    expect(captured.logs).to.include('Proposed change request #7 from branch cr-smoke.')
    expect(captured.logs).to.include(`  ${APP}${CR_PATH}`)
    expect(captured.logs).to.include('NOT LIVE')
    expect(captured.logs).to.include('It goes live only when someone with rights merges it. Check on it: qfg cr show 7')
  })

  it('T1: a propose with no title or description still sends an (empty) propose object', async () => {
    const {deps, captured} = makeDeps({packResult: OPENED})
    await runPush(input(dir, {propose: {}}), deps)
    expect(captured.pushPack[0].propose).to.deep.equal({})
  })

  it('T3: a 200 without changeRequest.number fails PROPOSE_UNSUPPORTED (an older server did a plain branch push)', async () => {
    const {deps, captured} = makeDeps({
      packResult: {kind: 'success', commitSha: NEW_SHA, ref: 'refs/heads/cr-smoke'},
    })
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_UNSUPPORTED')
    expect(err.message).to.equal(
      'Branch cr-smoke was pushed, but the server did not open a change request (it may be older than this CLI). Nothing is proposed and nothing went live.',
    )
    expect(captured.logs.join('\n')).to.not.include('NOT LIVE')
  })

  it('T4: on main with 2 unpushed commits, refuses before any push and prints the two git commands', async () => {
    const {deps, captured} = makeDeps({branch: {kind: 'branch', name: 'main'}, ahead: 2})
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_ON_MAIN')
    expect(captured.pushPack).to.have.length(0)
    expect(captured.pushToServer).to.equal(0)
    expect(err.message.split('\n')).to.deep.equal([
      '--propose needs a branch: commits on main go live when pushed.',
      'Move your 2 unpushed commit(s) to a branch (this CLI will not move your branches for you):',
      '  git switch -c <branch-name>',
      '  git branch -f main origin/main',
      'Then run: qfg push --propose',
    ])
  })

  it('T4: on main with nothing unpushed, refuses and says to create a branch first', async () => {
    const {deps, captured} = makeDeps({branch: {kind: 'branch', name: 'main'}, ahead: 0})
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_ON_MAIN')
    expect(captured.pushPack).to.have.length(0)
    expect(err.message.split('\n')).to.deep.equal([
      '--propose needs a branch: commits on main go live when pushed.',
      'Create a branch (git switch -c <branch-name>), commit, then run qfg push --propose.',
    ])
  })

  it('T4: on the bare path (no clone), refuses before any write', async () => {
    const {deps, captured} = makeDeps({isGitRepo: false})
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_NEEDS_CLONE')
    expect(err.message).to.equal(
      '--propose needs a git clone of the workspace in this step. Run qfg pull, create a branch, commit, then qfg push --propose.',
    )
    expect(captured.pushToServer).to.equal(0)
    expect(captured.pushPack).to.have.length(0)
  })

  it('T5: a plain branch push whose response carries changeRequest says the request was updated', async () => {
    const {deps, captured} = makeDeps({packResult: OPENED})
    const result = await runPush(input(dir, {yes: true}), deps)
    expect(captured.pushPack[0]).to.not.have.property('propose')
    expect(result.kind === 'pushed' && result.changeRequest?.number).to.equal(7)
    expect(captured.logs).to.include('Updated change request #7 with this push.')
    expect(captured.logs).to.include(`  ${APP}${CR_PATH}`)
    expect(captured.logs).to.include('NOT LIVE')
  })

  it('T5: a plain branch push without changeRequest prints exactly what it printed before', async () => {
    const {deps, captured} = makeDeps({})
    const result = await runPush(input(dir, {yes: true}), deps)
    expect(captured.pushPack[0]).to.not.have.property('propose')
    expect(result.kind === 'pushed' && 'changeRequest' in result).to.equal(false)
    expect(captured.logs.slice(-1)).to.deep.equal([
      `Pushed 1 commit(s) to origin/refs/heads/cr-smoke as ${NEW_SHA.slice(0, 7)}. Local repo in sync.`,
    ])
    expect(captured.logs.join('\n')).to.not.match(/change request|not live/i)
  })

  const DENIED: GitPushResult = {
    kind: 'denied',
    denials: [
      {
        commitSha: 'deadbeefcafebabe0000000000000000abcdef00',
        path: 'feature-flags/a.json',
        reason: 'Missing required permission to edit feature-flags/a.json: config.edit.protected',
        requiredPermission: 'config.edit.protected',
      },
    ],
  }

  it('T6: a refused MAIN push on the clone path prints the propose hint after the unchanged denial lines', async () => {
    const {deps, captured} = makeDeps({branch: {kind: 'branch', name: 'main'}, packResult: DENIED})
    const err = await catchFatal(runPush(input(dir, {yes: true}), deps))
    expect(err.code).to.equal('PUSH_DENIED')
    expect(err.message).to.equal('Push denied for 1 commit(s). See errors above.')
    expect(err.proposable).to.equal(true)
    expect(captured.errs).to.deep.equal([
      'Push denied for 1 commit(s):',
      '  deadbeef  Missing required permission to edit feature-flags/a.json: config.edit.protected',
      '',
      'You can propose this change instead; someone with rights merges it:',
      '  git switch -c <branch-name>',
      '  git branch -f main origin/main',
      '  qfg push --propose',
    ])
  })

  it('T6: a refused BRANCH push prints no propose hint', async () => {
    const {deps, captured} = makeDeps({packResult: DENIED})
    const err = await catchFatal(runPush(input(dir, {yes: true}), deps))
    expect(err.code).to.equal('PUSH_DENIED')
    expect(err.proposable).to.equal(undefined)
    expect(captured.errs.join('\n')).to.not.include('propose')
  })

  it('T6: a refused bare-path push prints no propose hint', async () => {
    const {deps, captured} = makeDeps({
      isGitRepo: false,
      pushResult: {
        kind: 'denied',
        denials: [{path: 'feature-flags/a.json', reason: 'nope', requiredPermission: 'config.edit.protected'}],
      },
    })
    const err = await catchFatal(runPush(input(dir, {yes: true}), deps))
    expect(err.code).to.equal('PUSH_DENIED')
    expect(err.proposable).to.equal(undefined)
    expect(captured.errs.join('\n')).to.not.include('propose')
  })
})
