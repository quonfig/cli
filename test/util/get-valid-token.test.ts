import {expect} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {getValidAccessToken} from '../../src/util/get-valid-token.js'
import {saveTokens, type TokenStorageOptions} from '../../src/util/token-storage.js'

/**
 * These tests exercise the QUONFIG_API_KEY short-circuit in getValidAccessToken().
 *
 * We redirect HOME to a per-test tmp dir so the code path reading
 * ~/.quonfig/tokens.json is isolated from the developer's real session.
 * A successful env-key short-circuit must return the key without reading
 * or writing that directory.
 */
describe('get-valid-token (QUONFIG_API_KEY)', () => {
  const testRoot = path.join(os.tmpdir(), '.quonfig-get-valid-token-test-' + Date.now())
  const fakeHome = path.join(testRoot, 'home')
  const quonfigDir = path.join(fakeHome, '.quonfig')
  const tokenOptions: TokenStorageOptions = {quonfigDir}
  let originalHome: string | undefined
  let originalApiKey: string | undefined

  beforeEach(() => {
    fs.mkdirSync(quonfigDir, {recursive: true})
    originalHome = process.env.HOME
    originalApiKey = process.env.QUONFIG_API_KEY
    process.env.HOME = fakeHome
    delete process.env.QUONFIG_API_KEY
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }

    if (originalApiKey === undefined) {
      delete process.env.QUONFIG_API_KEY
    } else {
      process.env.QUONFIG_API_KEY = originalApiKey
    }

    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, {recursive: true})
    }
  })

  it('returns the env key directly when QUONFIG_API_KEY starts with qf_uk_', async () => {
    process.env.QUONFIG_API_KEY = 'qf_uk_abcdef'

    const token = await getValidAccessToken()

    expect(token).to.equal('qf_uk_abcdef')
  })

  it('does not read or write the tokens file when QUONFIG_API_KEY is set', async () => {
    process.env.QUONFIG_API_KEY = 'qf_uk_abcdef0123456789'

    // Seed a bogus tokens file — if the code reads disk, it would pick up
    // this (expired, fake) accessToken and try to refresh, which would fail.
    // Short-circuit path must ignore the file entirely.
    await saveTokens(
      {
        tokensByOrg: {
          org_test: {
            access_token: 'DISK_SHOULD_BE_IGNORED',
            expires_at: 1000, // long expired
            refresh_token: 'fake-refresh',
          },
        },
      },
      tokenOptions,
    )

    // Snapshot the directory contents to confirm nothing gets rewritten.
    const beforeEntries = fs.readdirSync(quonfigDir).sort()
    const beforeMtimes = beforeEntries.map((name) => fs.statSync(path.join(quonfigDir, name)).mtimeMs)

    const token = await getValidAccessToken()

    expect(token).to.equal('qf_uk_abcdef0123456789')

    const afterEntries = fs.readdirSync(quonfigDir).sort()
    const afterMtimes = afterEntries.map((name) => fs.statSync(path.join(quonfigDir, name)).mtimeMs)

    expect(afterEntries).to.deep.equal(beforeEntries)
    expect(afterMtimes).to.deep.equal(beforeMtimes)
  })

  it('throws a clear error when QUONFIG_API_KEY has a bad prefix', async () => {
    process.env.QUONFIG_API_KEY = 'bad_prefix_xyz_this_full_secret_should_not_leak'

    let caught: Error | undefined
    try {
      await getValidAccessToken()
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('qf_uk_')
    expect(caught!.message).to.include('Settings')
    // Error must not leak the full key — only the first 8 chars.
    expect(caught!.message).to.not.include('this_full_secret_should_not_leak')
    expect(caught!.message).to.include('bad_pref')
  })

  it('falls through to disk path when QUONFIG_API_KEY is empty', async () => {
    process.env.QUONFIG_API_KEY = ''

    // No tokens on disk, so we expect the canonical "Not authenticated" error.
    let caught: Error | undefined
    try {
      await getValidAccessToken()
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('Not authenticated')
  })

  it('falls through to disk path when QUONFIG_API_KEY is unset', async () => {
    delete process.env.QUONFIG_API_KEY

    let caught: Error | undefined
    try {
      await getValidAccessToken()
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('Not authenticated')
  })
})
