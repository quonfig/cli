import {expect} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {resolveWorkspaceUuid} from '../../src/util/resolve-workspace.js'
import {loadAuthConfig, saveTokens} from '../../src/util/token-storage.js'

/**
 * qfg-ogr: when loadAuthConfig() returns null but valid tokens exist,
 * resolveWorkspaceUuid must refresh + call /userWorkspaces/list to recover
 * a profile rather than bailing out with "Not logged in".
 */
describe('resolve-workspace recovery from tokens', () => {
  const testRoot = path.join(os.tmpdir(), '.quonfig-resolve-recovery-' + Date.now())
  const fakeHome = path.join(testRoot, 'home')
  const quonfigDir = path.join(fakeHome, '.quonfig')
  let originalHome: string | undefined
  let originalApiKey: string | undefined
  let originalDomain: string | undefined
  let originalApiOverride: string | undefined
  let originalFetch: typeof globalThis.fetch

  const buildJwt = (expSecondsFromNow: number) => {
    const payload = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user_test',
      }),
    ).toString('base64')
    return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
  }

  beforeEach(async () => {
    fs.mkdirSync(quonfigDir, {recursive: true})
    originalHome = process.env.HOME
    originalApiKey = process.env.QUONFIG_API_KEY
    originalDomain = process.env.QUONFIG_DOMAIN
    originalApiOverride = process.env.QUONFIG_API_BASE_URL_OVERRIDE
    process.env.HOME = fakeHome
    delete process.env.QUONFIG_API_KEY
    delete process.env.QUONFIG_DOMAIN
    delete process.env.QUONFIG_API_BASE_URL_OVERRIDE

    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
    else process.env.QUONFIG_API_KEY = originalApiKey
    if (originalDomain === undefined) delete process.env.QUONFIG_DOMAIN
    else process.env.QUONFIG_DOMAIN = originalDomain
    if (originalApiOverride === undefined) delete process.env.QUONFIG_API_BASE_URL_OVERRIDE
    else process.env.QUONFIG_API_BASE_URL_OVERRIDE = originalApiOverride

    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, {recursive: true})
    }
  })

  const makeFakeCommand = () => {
    const errors: string[] = []
    const cmd = {
      errors,
      verboseLog() {},
      error(msg: string | Error) {
        const text = typeof msg === 'string' ? msg : msg.message
        errors.push(text)
        throw new Error(text)
      },
    }
    // resolveWorkspaceUuid expects a BaseCommand; the fake satisfies the
    // narrow surface it uses (verboseLog, error).
    return cmd as unknown as {errors: string[]} & Parameters<typeof resolveWorkspaceUuid>[0]
  }

  it('refreshes tokens, calls /userWorkspaces/list, saves a profile, and returns the workspace id', async () => {
    await saveTokens({
      accessToken: buildJwt(3600),
      expiresAt: Date.now() + 3_600_000,
      refreshToken: 'mock-refresh-token',
    })

    let listCalled = false
    let bearerSent: string | undefined
    globalThis.fetch = (async (url: unknown, init?: {headers?: Record<string, string>}) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        listCalled = true
        bearerSent = init?.headers?.Authorization
        return new Response(
          JSON.stringify({
            json: [
              {
                workspaceId: 'ws-recovered-uuid',
                workspaceSlug: 'recovered',
                workosOrgId: 'org_recovered',
                organizationName: 'Recovered Org',
              },
            ],
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        )
      }

      throw new Error(`unexpected fetch in test: ${u}`)
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    const result = await resolveWorkspaceUuid(cmd)

    expect(listCalled, 'must call /userWorkspaces/list during recovery').to.equal(true)
    expect(bearerSent).to.match(/^Bearer /)
    expect(result).to.equal('ws-recovered-uuid')

    // Specific mechanism: the fix must persist the recovered profile so
    // subsequent commands can read it.
    const savedConfig = await loadAuthConfig()
    expect(savedConfig, 'recovery must persist a profile via saveAuthConfig').to.not.be.null
    expect(savedConfig!.profiles.default.workspace).to.equal('ws-recovered-uuid')
    expect(savedConfig!.profiles.default.workspaceSlug).to.equal('recovered')
  })

  it('errors with a clear message when tokens exist but /userWorkspaces/list returns no entries', async () => {
    await saveTokens({
      accessToken: buildJwt(3600),
      expiresAt: Date.now() + 3_600_000,
      refreshToken: 'mock-refresh-token',
    })

    globalThis.fetch = (async (url: unknown) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        return new Response(JSON.stringify({json: []}), {
          status: 200,
          headers: {'Content-Type': 'application/json'},
        })
      }

      throw new Error(`unexpected fetch in test: ${u}`)
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd)
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.include('qfg login')
    expect(caught!.message).to.match(/no workspace|repopulate/i)
  })

  it('errors with a clear message when no tokens exist on disk', async () => {
    // No saveTokens() call — tokens.json is absent.
    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called when no tokens are present')
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd)
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.include('qfg login')
  })
})
