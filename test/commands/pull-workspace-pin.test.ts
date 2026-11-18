/**
 * qfg-5bjew.46: `qfg pull` with QUONFIG_API_KEY must not compare or backfill
 * the quonfig.json workspace pin against an empty org slug.
 *
 * - org/ws form: the API-key branch of resolveWorkspaceUuid returns the org
 *   slug from /userWorkspaces/list, so a matching pin draws no warning.
 * - UUID form: no org slug is known, so pull skips the pin compare and the
 *   backfill. It never writes a malformed "/<ws>" pin.
 *
 * Command tests run dist/: `yarn build` first. The workspace repo is a local
 * bare repo that the cached Gitea token entry points at.
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
const WS_ID = '11111111-2222-3333-4444-555555555555'
const ORG = 'e2e-flag-org'
const WS = 'cr-e2e-5bjew18'

async function git(dir: string, ...args: string[]): Promise<string> {
  const {stdout} = await execFile('git', ['-C', dir, ...args])
  return stdout
}

const ENV_KEYS = ['QUONFIG_API_KEY', 'QUONFIG_WORKSPACE', 'QUONFIG_DIR'] as const

describe('qfg pull workspace pin with QUONFIG_API_KEY (qfg-5bjew.46)', function () {
  this.timeout(120_000)
  // Paths are fixed at load time because oclif/test command args are.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-ws-pin-'))
  const pinnedBare = path.join(root, 'pinned.git')
  const unpinnedBare = path.join(root, 'unpinned.git')
  const cloneOrgWs = path.join(root, 'clone-org-ws')
  const cloneUuidPinned = path.join(root, 'clone-uuid-pinned')
  const cloneUuidUnpinned = path.join(root, 'clone-uuid-unpinned')
  const prevEnv: Record<string, string | undefined> = {}
  let originalFetch: typeof globalThis.fetch

  async function seedBare(bare: string, quonfigJson: string): Promise<void> {
    const seed = `${bare}-seed`
    await execFile('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
    fs.mkdirSync(seed)
    await git(seed, 'init', '-q', '--initial-branch=main')
    await git(seed, 'config', 'user.email', 'test@quonfig.test')
    await git(seed, 'config', 'user.name', 'Test')
    await git(seed, 'config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(seed, 'quonfig.json'), quonfigJson)
    fs.writeFileSync(path.join(seed, 'flag.json'), '{"a": 1}\n')
    await git(seed, 'add', '-A')
    await git(seed, 'commit', '-q', '-m', 'seed')
    await git(seed, 'push', '-q', bare, 'main')
  }

  const pointTokenAt = (bare: string) =>
    saveGiteaToken(WS_ID, {expiresAt: null, repoUrl: `file://${bare}`, token: 't', workspaceSlug: WS})

  before(async () => {
    setupTestAuth()
    await seedBare(pinnedBare, `{"workspace":"${ORG}/${WS}"}\n`)
    await seedBare(unpinnedBare, '{}\n')

    for (const k of ENV_KEYS) prevEnv[k] = process.env[k]
    process.env.QUONFIG_API_KEY = 'qf_sa_test_key'

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        return new Response(JSON.stringify({json: [{organizationSlug: ORG, workspaceId: WS_ID, workspaceSlug: WS}]}), {
          status: 200,
          headers: {'Content-Type': 'application/json'},
        })
      }

      throw new Error(`unexpected fetch in test: ${u}`)
    }) as typeof globalThis.fetch
  })

  after(() => {
    globalThis.fetch = originalFetch
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }

    fs.rmSync(root, {force: true, recursive: true})
    cleanupTestAuth()
  })

  test
    .do(async () => {
      await pointTokenAt(pinnedBare)
      process.env.QUONFIG_WORKSPACE = `${ORG}/${WS}`
      process.env.QUONFIG_DIR = cloneOrgWs
    })
    .stdout()
    .command(['pull', '--dir', cloneOrgWs])
    .it('org/ws form: a fresh clone with a matching pin prints no pin warning', (ctx) => {
      expect(ctx.stdout).to.contain('Cloned successfully')
      expect(ctx.stdout).to.not.contain('Warning: quonfig.json pins workspace')
    })

  test
    .stdout()
    .command(['pull', '--dir', cloneOrgWs])
    .it('org/ws form: a pull of the existing clone prints no pin warning', (ctx) => {
      expect(ctx.stdout).to.not.contain('Warning: quonfig.json pins workspace')
    })

  test
    .do(async () => {
      await pointTokenAt(pinnedBare)
      process.env.QUONFIG_WORKSPACE = WS_ID
      process.env.QUONFIG_DIR = cloneUuidPinned
    })
    .stdout()
    .command(['pull', '--dir', cloneUuidPinned])
    .it('UUID form: a pinned clone prints no pin warning (org unknown, compare skipped)', (ctx) => {
      expect(ctx.stdout).to.contain('Cloned successfully')
      expect(ctx.stdout).to.not.contain('Warning: quonfig.json pins workspace')
    })

  test
    .do(async () => {
      await pointTokenAt(unpinnedBare)
      process.env.QUONFIG_WORKSPACE = WS_ID
      process.env.QUONFIG_DIR = cloneUuidUnpinned
    })
    .stdout()
    .command(['pull', '--dir', cloneUuidUnpinned])
    .it('UUID form: an unpinned clone does not get a malformed "/<ws>" pin backfilled', async (ctx) => {
      expect(ctx.stdout).to.contain('Cloned successfully')
      const onDisk = JSON.parse(fs.readFileSync(path.join(cloneUuidUnpinned, 'quonfig.json'), 'utf8'))
      expect(onDisk.workspace).to.equal(undefined)
      expect(await git(cloneUuidUnpinned, 'log', '--format=%s')).to.not.contain('workspace pin')
    })
})
