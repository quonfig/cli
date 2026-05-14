import {expect} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {getValidAccessToken} from '../../src/util/get-valid-token.js'
import {loadTokens, saveTokens, type TokenStorageOptions} from '../../src/util/token-storage.js'

const buildJwt = (payload: Record<string, unknown>): string => {
  const header = Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT'})).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

/**
 * These tests exercise the QUONFIG_API_KEY short-circuit in getValidAccessToken().
 *
 * We redirect QUONFIG_CONFIG_HOME to a per-test tmp dir so the code path
 * reading the token store is isolated from the developer's real session.
 * (HOME isn't enough — on Windows os.homedir() reads USERPROFILE, so the
 * token-storage helpers would still hit the real config dir. qfg-qilt.)
 * A successful env-key short-circuit must return the key without reading
 * or writing that directory.
 */
describe('get-valid-token (QUONFIG_API_KEY)', () => {
  const testRoot = path.join(os.tmpdir(), '.quonfig-get-valid-token-test-' + Date.now())
  const fakeHome = path.join(testRoot, 'home')
  const quonfigDir = path.join(fakeHome, '.quonfig')
  const tokenOptions: TokenStorageOptions = {quonfigDir}
  let originalConfigHome: string | undefined
  let originalApiKey: string | undefined

  beforeEach(() => {
    fs.mkdirSync(quonfigDir, {recursive: true})
    originalConfigHome = process.env.QUONFIG_CONFIG_HOME
    originalApiKey = process.env.QUONFIG_API_KEY
    process.env.QUONFIG_CONFIG_HOME = quonfigDir
    delete process.env.QUONFIG_API_KEY
  })

  afterEach(() => {
    if (originalConfigHome === undefined) {
      delete process.env.QUONFIG_CONFIG_HOME
    } else {
      process.env.QUONFIG_CONFIG_HOME = originalConfigHome
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

    const token = await getValidAccessToken('org_unused')

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

    const token = await getValidAccessToken('org_unused')

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
      await getValidAccessToken('org_unused')
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

    // No tokens on disk, so we expect the canonical "No token for org" error.
    let caught: Error | undefined
    try {
      await getValidAccessToken('org_alpha')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('org_alpha')
  })

  it('falls through to disk path when QUONFIG_API_KEY is unset', async () => {
    delete process.env.QUONFIG_API_KEY

    let caught: Error | undefined
    try {
      await getValidAccessToken('org_alpha')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('org_alpha')
  })
})

describe('get-valid-token (per-org OAuth path)', () => {
  const testRoot = path.join(os.tmpdir(), '.quonfig-get-valid-token-oauth-test-' + Date.now())
  const fakeHome = path.join(testRoot, 'home')
  const quonfigDir = path.join(fakeHome, '.quonfig')
  const tokenOptions: TokenStorageOptions = {quonfigDir}
  let originalConfigHome: string | undefined
  let originalApiKey: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    fs.mkdirSync(quonfigDir, {recursive: true})
    originalConfigHome = process.env.QUONFIG_CONFIG_HOME
    originalApiKey = process.env.QUONFIG_API_KEY
    originalFetch = globalThis.fetch
    process.env.QUONFIG_CONFIG_HOME = quonfigDir
    delete process.env.QUONFIG_API_KEY
  })

  afterEach(() => {
    if (originalConfigHome === undefined) {
      delete process.env.QUONFIG_CONFIG_HOME
    } else {
      process.env.QUONFIG_CONFIG_HOME = originalConfigHome
    }

    if (originalApiKey === undefined) {
      delete process.env.QUONFIG_API_KEY
    } else {
      process.env.QUONFIG_API_KEY = originalApiKey
    }

    globalThis.fetch = originalFetch

    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, {recursive: true})
    }
  })

  it('returns the matching org token when valid', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const alphaJwt = buildJwt({exp: futureExp, org_id: 'org_alpha', sub: 'user_1'})
    const betaJwt = buildJwt({exp: futureExp, org_id: 'org_beta', sub: 'user_1'})

    await saveTokens(
      {
        tokensByOrg: {
          org_alpha: {access_token: alphaJwt, expires_at: futureExp * 1000, refresh_token: 'r_alpha'},
          org_beta: {access_token: betaJwt, expires_at: futureExp * 1000, refresh_token: 'r_beta'},
        },
      },
      tokenOptions,
    )

    const token = await getValidAccessToken('org_beta')

    expect(token).to.equal(betaJwt)
  })

  it('throws "No token for org <orgId>" when the org is not in the store', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    await saveTokens(
      {
        tokensByOrg: {
          org_alpha: {
            access_token: buildJwt({exp: futureExp, org_id: 'org_alpha'}),
            expires_at: futureExp * 1000,
            refresh_token: 'r_alpha',
          },
        },
      },
      tokenOptions,
    )

    let caught: Error | undefined
    try {
      await getValidAccessToken('org_missing')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('No token for org')
    expect(caught!.message).to.include('org_missing')
    expect(caught!.message).to.include('qfg login')
  })

  it('throws "No token" when no token store exists at all', async () => {
    let caught: Error | undefined
    try {
      await getValidAccessToken('org_alpha')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('org_alpha')
  })

  it('refreshes via authenticateWithOrg(refreshToken, workosOrgId) when the org token is expired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const expiredAlphaJwt = buildJwt({exp: pastExp, org_id: 'org_alpha'})
    const validBetaJwt = buildJwt({exp: futureExp, org_id: 'org_beta'})
    const refreshedJwt = buildJwt({exp: futureExp, org_id: 'org_alpha', sub: 'user_1'})

    await saveTokens(
      {
        tokensByOrg: {
          org_alpha: {access_token: expiredAlphaJwt, expires_at: pastExp * 1000, refresh_token: 'r_alpha'},
          org_beta: {access_token: validBetaJwt, expires_at: futureExp * 1000, refresh_token: 'r_beta'},
        },
      },
      tokenOptions,
    )

    const captured: {body?: URLSearchParams; url?: string} = {}
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.url = url
      captured.body = new URLSearchParams((init.body as URLSearchParams).toString())
      return {
        ok: true,
        json: async () => ({
          access_token: refreshedJwt,
          authentication_method: 'RefreshToken',
          refresh_token: 'r_alpha_v2',
          user: {id: 'user_1', email: 'foo@bar.com'},
        }),
      } as Response
    }) as typeof globalThis.fetch

    const token = await getValidAccessToken('org_alpha')

    expect(token).to.equal(refreshedJwt)
    // Asserts the refresh hop carried organization_id — the whole point of the
    // change. Without this param, WorkOS returns a user-scoped token with no
    // permissions[], which is the bug qfg-kr7 exists to fix.
    expect(captured.body?.get('organization_id')).to.equal('org_alpha')
    expect(captured.body?.get('grant_type')).to.equal('refresh_token')
    expect(captured.body?.get('refresh_token')).to.equal('r_alpha')

    // Per-org isolation: org_beta's slot must be unchanged on disk.
    const reloaded = await loadTokens(tokenOptions)
    expect(reloaded?.tokensByOrg.org_alpha.access_token).to.equal(refreshedJwt)
    expect(reloaded?.tokensByOrg.org_alpha.refresh_token).to.equal('r_alpha_v2')
    expect(reloaded?.tokensByOrg.org_beta.access_token).to.equal(validBetaJwt)
    expect(reloaded?.tokensByOrg.org_beta.refresh_token).to.equal('r_beta')
  })

  it('surfaces refresh errors with the org context in the message', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600
    const expiredJwt = buildJwt({exp: pastExp, org_id: 'org_alpha'})

    await saveTokens(
      {
        tokensByOrg: {
          org_alpha: {access_token: expiredJwt, expires_at: pastExp * 1000, refresh_token: 'r_alpha'},
        },
      },
      tokenOptions,
    )

    globalThis.fetch = (async () =>
      ({
        ok: false,
        text: async () => 'invalid_grant: refresh token revoked',
      }) as Response) as typeof globalThis.fetch

    let caught: Error | undefined
    try {
      await getValidAccessToken('org_alpha')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected getValidAccessToken to throw').to.be.instanceOf(Error)
    expect(caught!.message).to.include('org_alpha')
  })
})
