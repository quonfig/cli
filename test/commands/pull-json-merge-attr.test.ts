/**
 * qfg-5bjew.28: `qfg pull` ensures `*.json -merge` in the clone's
 * `.git/info/attributes`, on a fresh clone and on every update, without
 * duplicating it. Command tests run dist/: `yarn build` first.
 *
 * The workspace repo is a local bare repo: the cached Gitea token entry points
 * `repoUrl` at its file:// URL, and QUONFIG_API_KEY + a UUID workspace keeps
 * workspace resolution offline.
 */

import {expect, test} from '@oclif/test'
import {execFile as execFileCb} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as util from 'node:util'

import {saveGiteaToken} from '../../src/util/gitea-token-storage.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const execFile = util.promisify(execFileCb)
const WS = '11111111-2222-3333-4444-555555555555'

async function git(dir: string, ...args: string[]): Promise<string> {
  const {stdout} = await execFile('git', ['-C', dir, ...args])
  return stdout
}

const attributeLines = (clone: string) =>
  fs
    .readFileSync(path.join(clone, '.git', 'info', 'attributes'), 'utf8')
    .split('\n')
    .filter((l) => l === '*.json -merge')

describe('qfg pull writes *.json -merge (qfg-5bjew.28)', function () {
  this.timeout(120_000)
  // Paths are fixed at load time because oclif/test command args are.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-json-merge-'))
  const bare = path.join(root, 'ws.git')
  const clone = path.join(root, 'clone')
  const prevEnv: Record<string, string | undefined> = {}

  before(async () => {
    setupTestAuth()
    const seed = path.join(root, 'seed')
    await execFile('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
    fs.mkdirSync(seed)
    await git(seed, 'init', '-q', '--initial-branch=main')
    await git(seed, 'config', 'user.email', 'test@quonfig.test')
    await git(seed, 'config', 'user.name', 'Test')
    await git(seed, 'config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(seed, 'quonfig.json'), '{"workspace":"test-organization/ws"}\n')
    await git(seed, 'add', '-A')
    await git(seed, 'commit', '-q', '-m', 'seed')
    await git(seed, 'push', '-q', bare, 'main')

    await saveGiteaToken(WS, {expiresAt: null, repoUrl: `file://${bare}`, token: 't', workspaceSlug: 'ws'})

    for (const k of ['QUONFIG_API_KEY', 'QUONFIG_WORKSPACE', 'QUONFIG_DIR']) prevEnv[k] = process.env[k]
    process.env.QUONFIG_API_KEY = 'qf_test_key'
    process.env.QUONFIG_WORKSPACE = WS
    process.env.QUONFIG_DIR = clone
  })

  after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }

    fs.rmSync(root, {force: true, recursive: true})
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['pull', '--dir', clone])
    .it('a fresh clone gets the attribute, not a committed .gitattributes', (ctx) => {
      expect(ctx.stdout).to.contain('Cloned successfully')
      expect(attributeLines(clone)).to.have.length(1)
      expect(fs.existsSync(path.join(clone, '.gitattributes'))).to.equal(false)
    })

  test
    .do(() => fs.rmSync(path.join(clone, '.git', 'info', 'attributes'), {force: true}))
    .stdout()
    .command(['pull', '--dir', clone])
    .it('a pull of an existing clone that lacks it adds it', (ctx) => {
      expect(ctx.stdout).to.contain('Fetching from remote')
      expect(attributeLines(clone)).to.have.length(1)
    })

  test
    .stdout()
    .command(['pull', '--dir', clone])
    .it('a further pull does not add it again', () => {
      expect(attributeLines(clone)).to.have.length(1)
    })
})
