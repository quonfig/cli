/**
 * `qfg push --propose` on the BARE path (no clone) — qfg-5bjew.37, Q5 of
 * project/plans/2026-09-08-change-requests/step3-decomposition.md section 7:
 * lift PROPOSE_NEEDS_CLONE and send the file deltas through
 * changeRequests.propose as set_document / delete ops. Nothing goes live,
 * so there is no confirm prompt.
 */

import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  PushFatalError,
  runPush,
  type FileDelta,
  type GitOps,
  type GiteaTokenMintResult,
  type ProposeToServerInput,
  type ProposeToServerResult,
  type RunPushDeps,
  type RunPushInput,
} from '../../src/push/run-push.js'

const BACKEND_UUID = '00000000-0000-4000-8000-000000000001'
const APP = 'https://app.example.test'
const MAIN_SHA = '00112233445566778899aabbccddeeff00112233'
const HEAD_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'

const BACKEND: GiteaTokenMintResult = {
  token: 'fake-read-token',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
  expiresAt: null,
  workspaceSlug: 'acme-prod',
  workspaceId: BACKEND_UUID,
}

const FLAG_AFTER = {key: 'checkout', type: 'feature_flag', valueType: 'bool', default: {rules: []}, environments: []}

const OPENED: ProposeToServerResult = {
  kind: 'success',
  changeRequest: {
    number: 12,
    url: `/workspaces/${BACKEND_UUID}/change-requests/12`,
    status: 'open',
    branch: 'cr/12',
    headSha: HEAD_SHA,
    changes: [{type: 'flag', key: 'checkout', summary: ['production: enabled false -> true']}],
  },
}

interface Captured {
  errs: string[]
  logs: string[]
  propose: ProposeToServerInput[]
  pushToServer: number
}

function makeDeps(deltas: FileDelta[], proposeResult: ProposeToServerResult = OPENED) {
  const captured: Captured = {errs: [], logs: [], propose: [], pushToServer: 0}
  const gitOps = {
    isGitRepo: async () => false,
    async getRemoteOriginUrl() {},
    getAllRemoteUrls: async () => [],
    async setRemoteOrigin() {},
    async fetch() {},
    diffHeadVsOrigin: async () => deltas,
    countFilesInRemote: async () => 100,
    isLocalBehindRemote: async () => false,
    dirtyTrackedFiles: async () => [],
    getOriginMainSha: async () => MAIN_SHA,
  } as unknown as GitOps

  const deps: RunPushDeps = {
    mintWriteToken: async () => BACKEND,
    validate: async () => ({errors: []}),
    gitOps,
    async pushToServer() {
      captured.pushToServer += 1
      return {kind: 'success', commitSha: 'abc'}
    },
    async pushPackToServer() {
      throw new Error('the bare path never pack-pushes')
    },
    async proposeToServer(sent) {
      captured.propose.push(sent)
      return proposeResult
    },
    log: (l) => captured.logs.push(l),
    errLog: (l) => captured.errs.push(l),
  }
  return {deps, captured}
}

const input = (dir: string, extra: Partial<RunPushInput> = {}): RunPushInput => ({
  dir,
  requestedTarget: BACKEND_UUID,
  yes: false,
  interactive: false,
  skipValidate: true,
  noPinWrite: true,
  ...extra,
})

async function catchFatal(p: Promise<unknown>): Promise<PushFatalError> {
  try {
    await p
  } catch (error) {
    expect(error).to.be.instanceOf(PushFatalError)
    return error as PushFatalError
  }

  throw new Error('expected a PushFatalError')
}

describe('runPush --propose on the bare path (qfg-5bjew.37)', () => {
  const savedApp = process.env.QUONFIG_APP_BASE_URL_OVERRIDE
  let dir: string
  beforeEach(() => {
    process.env.QUONFIG_APP_BASE_URL_OVERRIDE = APP
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-push-propose-bare-')))
    fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({workspace: 'acme/acme-prod'}))
  })
  afterEach(() => {
    if (savedApp === undefined) delete process.env.QUONFIG_APP_BASE_URL_OVERRIDE
    else process.env.QUONFIG_APP_BASE_URL_OVERRIDE = savedApp
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('sends modified files as set_document and deleted files as delete, with the probe HEAD as token; no prompt', async () => {
    const {deps, captured} = makeDeps([
      {kind: 'modified', path: 'feature-flags/checkout.json', beforeJson: '{}', afterJson: JSON.stringify(FLAG_AFTER)},
      {kind: 'deleted', path: 'configs/old.timeout.json', beforeJson: '{}'},
      {kind: 'modified', path: 'log-levels/log-level.app.json', beforeJson: '{}', afterJson: '{"key":"log-level.app"}'},
    ])
    const result = await runPush(input(dir, {propose: {title: 'turn on checkout', description: 'why'}}), deps)

    expect(captured.pushToServer, 'configs.push must not be called').to.equal(0)
    expect(captured.propose).to.deep.equal([
      {
        workspaceId: BACKEND_UUID,
        title: 'turn on checkout',
        description: 'why',
        changes: [
          {op: 'set_document', type: 'flag', key: 'checkout', document: FLAG_AFTER, expectedCommitSha: MAIN_SHA},
          {op: 'delete', type: 'config', key: 'old.timeout', expectedCommitSha: MAIN_SHA},
          {
            op: 'set_document',
            type: 'log-level',
            key: 'log-level.app',
            document: {key: 'log-level.app'},
            expectedCommitSha: MAIN_SHA,
          },
        ],
      },
    ])

    expect(result).to.deep.include({kind: 'pushed', dispatchedAs: 'bare-path', branch: 'cr/12', commitSha: HEAD_SHA})
    if (result.kind !== 'pushed') return
    expect(result.changeRequest).to.deep.equal({
      number: 12,
      url: `/workspaces/${BACKEND_UUID}/change-requests/12`,
      status: 'open',
    })
    expect(captured.logs).to.include(`  ${APP}/workspaces/${BACKEND_UUID}/change-requests/12`)
    expect(captured.logs).to.include('NOT LIVE')
    expect(captured.logs).to.include('Check on it: qfg cr show 12 / Wait: qfg cr wait 12')
  })

  it('refuses an ADDED file (no op creates a document from a file) before sending anything', async () => {
    const {deps, captured} = makeDeps([
      {kind: 'added', path: 'feature-flags/new.flag.json', afterJson: '{"key":"new.flag"}'},
    ])
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_UNSUPPORTED_CHANGE')
    expect(err.message).to.equal(
      'qfg push --propose without a clone can propose changes to and deletes of existing flags, configs and log levels. These cannot be proposed this way: feature-flags/new.flag.json (new file). Use qfg create --propose for a new item, or propose from a clone (qfg pull, branch, commit, qfg push --propose).',
    )
    expect(captured.propose).to.have.length(0)
    expect(captured.pushToServer).to.equal(0)
  })

  it('refuses segments and schemas', async () => {
    const {deps, captured} = makeDeps([
      {kind: 'modified', path: 'segments/beta.json', beforeJson: '{}', afterJson: '{}'},
    ])
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_UNSUPPORTED_CHANGE')
    expect(err.message).to.contain('segments/beta.json')
    expect(captured.propose).to.have.length(0)
  })

  it('fails when the response carries no change-request number (an older server)', async () => {
    const {deps} = makeDeps(
      [
        {
          kind: 'modified',
          path: 'feature-flags/checkout.json',
          beforeJson: '{}',
          afterJson: JSON.stringify(FLAG_AFTER),
        },
      ],
      {kind: 'error', status: 404, message: 'Not found'},
    )
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_UNSUPPORTED')
    expect(err.message).to.equal(
      'The server did not open a change request (it may be older than this CLI). Nothing is proposed and nothing went live.',
    )
  })

  it('a refused proposal surfaces the server message', async () => {
    const {deps} = makeDeps(
      [
        {
          kind: 'modified',
          path: 'feature-flags/checkout.json',
          beforeJson: '{}',
          afterJson: JSON.stringify(FLAG_AFTER),
        },
      ],
      {
        kind: 'error',
        status: 409,
        message: 'feature-flags/checkout.json changed since 0011223',
        data: {changeIndex: 0},
      },
    )
    const err = await catchFatal(runPush(input(dir, {propose: {}}), deps))
    expect(err.code).to.equal('PROPOSE_REFUSED')
    expect(err.message).to.equal('Failed to propose: 409: feature-flags/checkout.json changed since 0011223')
  })
})
