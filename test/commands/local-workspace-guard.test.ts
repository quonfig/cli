import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {resetClientCache} from '../../src/util/get-client.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

// Every command marked writesHostedWorkspace refuses inside a local-only
// workspace (quonfig.json without a "workspace" pin) before it resolves a
// client, so no API mock is needed.
const HOSTED_WRITES: string[][] = [
  ['create', 'some.flag', '--type=boolean-flag'],
  ['delete', 'some.flag'],
  ['set-default', 'some.flag', '--value=true', '--environment=production'],
  ['set-rollout', 'some.flag', '--environment=production', '--true-percent=50'],
  ['override', 'some.flag', 'true'],
  ['log-level', 'log-level.some-app', '--value=WARN'],
  ['activity:restore', 'some.flag'],
]

describe('hosted write commands inside a local-only workspace', () => {
  let localDir: string
  let saved: {dir?: string; ws?: string}

  before(() => setupTestAuth())
  after(() => cleanupTestAuth())

  beforeEach(() => {
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-guard-'))
    fs.writeFileSync(path.join(localDir, 'quonfig.json'), '{"environments": []}\n')
    saved = {dir: process.env.QUONFIG_DIR, ws: process.env.QUONFIG_WORKSPACE}
    process.env.QUONFIG_DIR = localDir
    delete process.env.QUONFIG_WORKSPACE
  })

  afterEach(() => {
    if (saved.dir === undefined) delete process.env.QUONFIG_DIR
    else process.env.QUONFIG_DIR = saved.dir
    if (saved.ws !== undefined) process.env.QUONFIG_WORKSPACE = saved.ws
    fs.rmSync(localDir, {force: true, recursive: true})
    resetClientCache()
  })

  for (const argv of HOSTED_WRITES) {
    test
      .stdout()
      .stderr()
      .command(argv)
      .catch((error) => {
        expect(error.message).to.contain('local-only Quonfig workspace')
        expect(error.message).to.contain('--workspace')
        expect(error.message).to.contain('QUONFIG_WORKSPACE')
      })
      .it(`qfg ${argv[0]} refuses`)
  }
})
