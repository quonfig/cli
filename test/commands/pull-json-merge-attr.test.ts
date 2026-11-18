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

// A flag file whose two edits below touch different lines, so a text merge
// would combine them silently.
const FLAG_BASE = '{\n  "a": 1,\n  "pad1": 0,\n  "pad2": 0,\n  "pad3": 0,\n  "b": 1\n}\n'

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
    fs.writeFileSync(path.join(seed, 'flag.json'), FLAG_BASE)
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

  test
    .do(async () => {
      // main moves "a"; the clone has a local commit that moves "b".
      const seed = path.join(root, 'seed')
      fs.writeFileSync(path.join(seed, 'flag.json'), FLAG_BASE.replace('"a": 1', '"a": 9'))
      await git(seed, 'commit', '-q', '-am', 'main edit')
      await git(seed, 'push', '-q', bare, 'main')
      await git(clone, 'config', 'user.email', 'test@quonfig.test')
      await git(clone, 'config', 'user.name', 'Test')
      await git(clone, 'config', 'commit.gpgsign', 'false')
      fs.writeFileSync(path.join(clone, 'flag.json'), FLAG_BASE.replace('"b": 1', '"b": 2'))
      await git(clone, 'commit', '-q', '-am', 'local edit')
    })
    .stdout()
    .command(['pull', '--dir', clone, '--rebase'])
    .catch(/Rebase paused/)
    .it('pull --rebase stops on a both-sides JSON edit and says how to see the local side', (ctx) => {
      expect(ctx.stdout).to.contain('flag.json')
      // With -merge git writes no conflict markers: the file holds main's
      // version only, so the guidance must not promise markers.
      const onDisk = fs.readFileSync(path.join(clone, 'flag.json'), 'utf8')
      expect(onDisk).to.not.contain('<<<<<<<')
      expect(ctx.stdout).to.not.contain('pick the values you want; remove the git conflict markers')
      expect(ctx.stdout).to.contain("holds only origin/main's version")
      expect(ctx.stdout).to.contain('git -C ' + clone + ' show REBASE_HEAD:<file>')
      expect(ctx.stdout).to.contain('rebase --skip')
    })
})
