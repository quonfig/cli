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
  let originalConfigHome: string | undefined
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
    originalConfigHome = process.env.QUONFIG_CONFIG_HOME
    originalApiKey = process.env.QUONFIG_API_KEY
    originalDomain = process.env.QUONFIG_DOMAIN
    originalApiOverride = process.env.QUONFIG_API_BASE_URL_OVERRIDE
    process.env.QUONFIG_CONFIG_HOME = quonfigDir
    delete process.env.QUONFIG_API_KEY
    delete process.env.QUONFIG_DOMAIN
    delete process.env.QUONFIG_API_BASE_URL_OVERRIDE

    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalConfigHome === undefined) delete process.env.QUONFIG_CONFIG_HOME
    else process.env.QUONFIG_CONFIG_HOME = originalConfigHome
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
      tokensByOrg: {
        org_test: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'mock-refresh-token',
          org_slug: 'recovered-org',
        },
      },
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
    expect(result.workspaceId).to.equal('ws-recovered-uuid')

    // Specific mechanism: the fix must persist the recovered profile so
    // subsequent commands can read it.
    const savedConfig = await loadAuthConfig()
    expect(savedConfig, 'recovery must persist a profile via saveAuthConfig').to.not.be.null
    expect(savedConfig!.profiles.default.workspace).to.equal('ws-recovered-uuid')
    expect(savedConfig!.profiles.default.workspaceSlug).to.equal('recovered')
  })

  it('errors with a clear message when tokens exist but /userWorkspaces/list returns no entries', async () => {
    await saveTokens({
      tokensByOrg: {
        org_test: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'mock-refresh-token',
        },
      },
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

/**
 * qfg-kr7.5: resolveWorkspaceUuid must parse org-slug/workspace-slug from
 * --workspace and QUONFIG_WORKSPACE, look up the workosOrgId via the local
 * token store (item 3's per-org shape carries org_slug after item 7 lands),
 * and resolve the workspaceSlug *within that org*. Bare slug is rejected
 * with a migration message — except in QUONFIG_API_KEY mode, which still
 * accepts bare slug because the API key itself encodes the org context.
 */
describe('resolve-workspace org/ws addressing', () => {
  const testRoot = path.join(os.tmpdir(), '.quonfig-resolve-orgws-' + Date.now())
  const fakeHome = path.join(testRoot, 'home')
  const quonfigDir = path.join(fakeHome, '.quonfig')
  let originalConfigHome: string | undefined
  let originalApiKey: string | undefined
  let originalDomain: string | undefined
  let originalApiOverride: string | undefined
  let originalWorkspace: string | undefined
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

  beforeEach(() => {
    fs.mkdirSync(quonfigDir, {recursive: true})
    originalConfigHome = process.env.QUONFIG_CONFIG_HOME
    originalApiKey = process.env.QUONFIG_API_KEY
    originalDomain = process.env.QUONFIG_DOMAIN
    originalApiOverride = process.env.QUONFIG_API_BASE_URL_OVERRIDE
    originalWorkspace = process.env.QUONFIG_WORKSPACE
    process.env.QUONFIG_CONFIG_HOME = quonfigDir
    delete process.env.QUONFIG_API_KEY
    delete process.env.QUONFIG_DOMAIN
    delete process.env.QUONFIG_API_BASE_URL_OVERRIDE
    delete process.env.QUONFIG_WORKSPACE

    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalConfigHome === undefined) delete process.env.QUONFIG_CONFIG_HOME
    else process.env.QUONFIG_CONFIG_HOME = originalConfigHome
    if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
    else process.env.QUONFIG_API_KEY = originalApiKey
    if (originalDomain === undefined) delete process.env.QUONFIG_DOMAIN
    else process.env.QUONFIG_DOMAIN = originalDomain
    if (originalApiOverride === undefined) delete process.env.QUONFIG_API_BASE_URL_OVERRIDE
    else process.env.QUONFIG_API_BASE_URL_OVERRIDE = originalApiOverride
    if (originalWorkspace === undefined) delete process.env.QUONFIG_WORKSPACE
    else process.env.QUONFIG_WORKSPACE = originalWorkspace

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
    return cmd as unknown as {errors: string[]} & Parameters<typeof resolveWorkspaceUuid>[0]
  }

  it('rejects bare slug from QUONFIG_WORKSPACE in OAuth mode with the migration message', async () => {
    await saveTokens({
      tokensByOrg: {
        org_acme: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'r',
          org_slug: 'acme',
        },
      },
    })

    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called: bare slug must be rejected before any HTTP call')
    }) as typeof globalThis.fetch

    process.env.QUONFIG_WORKSPACE = 'just-a-bare-slug'

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd)
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.include('org/workspace form')
    expect(caught!.message).to.include('acme/foo')
    expect(caught!.message).to.include('qfg login')
  })

  it('rejects bare slug from --workspace flag in OAuth mode', async () => {
    await saveTokens({
      tokensByOrg: {
        org_acme: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'r',
          org_slug: 'acme',
        },
      },
    })

    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called: bare slug must be rejected before any HTTP call')
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd, 'just-a-bare-slug')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.include('org/workspace form')
  })

  it('parses org/ws form, looks up workosOrgId in token store by org_slug, and resolves workspaceId within that org', async () => {
    await saveTokens({
      tokensByOrg: {
        org_acme_uuid: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'r_acme',
          org_slug: 'acme',
        },
        org_beta_uuid: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'r_beta',
          org_slug: 'beta',
        },
      },
    })

    let bearerSent: string | undefined
    globalThis.fetch = (async (url: unknown, init?: {headers?: Record<string, string>}) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        bearerSent = init?.headers?.Authorization
        return new Response(
          JSON.stringify({
            json: [
              // Same workspace slug "production" exists in BOTH orgs; the
              // resolver must pick the one matching the parsed org slug,
              // not just the first one with a slug match.
              {
                workspaceId: 'ws-acme-prod-uuid',
                workspaceSlug: 'production',
                workosOrgId: 'org_acme_uuid',
                organizationName: 'Acme',
              },
              {
                workspaceId: 'ws-beta-prod-uuid',
                workspaceSlug: 'production',
                workosOrgId: 'org_beta_uuid',
                organizationName: 'Beta',
              },
            ],
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        )
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    const result = await resolveWorkspaceUuid(cmd, 'beta/production')

    expect(bearerSent).to.match(/^Bearer /)
    // Specific mechanism assertion: the result must come from the org branch
    // matching the parsed org slug, not the other one. orgSlug must round-trip
    // so downstream callers (mintGiteaToken) can pick the right per-org JWT.
    expect(result.workspaceId).to.equal('ws-beta-prod-uuid')
    expect(result.orgSlug).to.equal('beta')
  })

  it('errors with "No token found for org" when the orgSlug is not in the token store', async () => {
    await saveTokens({
      tokensByOrg: {
        org_acme_uuid: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'r_acme',
          org_slug: 'acme',
        },
      },
    })

    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called when orgSlug is missing from store')
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd, 'unknown-org/foo')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.include('No token found for org')
    expect(caught!.message).to.include('unknown-org')
    expect(caught!.message).to.include('qfg login')
  })

  it('errors when the workspaceSlug does not exist within the resolved org', async () => {
    await saveTokens({
      tokensByOrg: {
        org_acme_uuid: {
          access_token: buildJwt(3600),
          expires_at: Date.now() + 3_600_000,
          refresh_token: 'r_acme',
          org_slug: 'acme',
        },
      },
    })

    globalThis.fetch = (async (url: unknown) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        return new Response(
          JSON.stringify({
            json: [
              {
                workspaceId: 'ws-acme-other',
                workspaceSlug: 'other',
                workosOrgId: 'org_acme_uuid',
                organizationName: 'Acme',
              },
            ],
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        )
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd, 'acme/missing-workspace')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.match(/missing-workspace|not found/i)
  })

  // qfg-dl87: bare slugs are no longer accepted in QUONFIG_API_KEY mode
  // either — QUONFIG_WORKSPACE has a single org/workspace form across every
  // surface (quonfig.json, interactive shell, error messages, CI).
  it('rejects bare slug in QUONFIG_API_KEY mode with the migration message', async () => {
    process.env.QUONFIG_API_KEY = 'qf_uk_abcdef'
    process.env.QUONFIG_WORKSPACE = 'bare-slug-in-ci'

    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called: bare slug must be rejected before any HTTP call')
    }) as typeof globalThis.fetch

    const cmd = makeFakeCommand()
    let caught: Error | undefined
    try {
      await resolveWorkspaceUuid(cmd)
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected resolveWorkspaceUuid to throw').to.exist
    expect(caught!.message).to.include('org/workspace form')
    expect(caught!.message).to.include('acme/foo')
  })

  // qfg-dl87: API-key path accepts the org-qualified form so test-* apps
  // set QUONFIG_WORKSPACE=mhw-works/prod-testing — the same value
  // quonfig.json, the interactive shell, and error messages all use.
  it('accepts org/workspace form in QUONFIG_API_KEY mode and matches on the org-qualified pin', async () => {
    process.env.QUONFIG_API_KEY = 'qf_uk_abcdef'
    process.env.QUONFIG_WORKSPACE = 'mhw-works/prod-testing'

    let listCalled = false
    globalThis.fetch = (async (url: unknown) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        listCalled = true
        return new Response(
          JSON.stringify({
            json: [
              // Same workspace slug exists in two orgs; the org component
              // must disambiguate so we don't return the wrong workspace.
              {
                workspaceId: 'ws-other-org',
                workspaceSlug: 'prod-testing',
                workosOrgId: 'org_other',
                organizationName: 'Other',
                organizationSlug: 'other-org',
              },
              {
                workspaceId: 'ws-mhw-prod-uuid',
                workspaceSlug: 'prod-testing',
                workosOrgId: 'org_mhw',
                organizationName: 'MHW Works',
                organizationSlug: 'mhw-works',
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

    expect(listCalled).to.equal(true)
    expect(result.workspaceId).to.equal('ws-mhw-prod-uuid')
    expect(result.orgSlug).to.equal('')
  })

  it('lists org-qualified pins in the API-key not-found error', async () => {
    process.env.QUONFIG_API_KEY = 'qf_uk_abcdef'
    process.env.QUONFIG_WORKSPACE = 'mhw-works/does-not-exist'

    globalThis.fetch = (async (url: unknown) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        return new Response(
          JSON.stringify({
            json: [
              {
                workspaceId: 'ws-mhw-prod-uuid',
                workspaceSlug: 'prod-testing',
                workosOrgId: 'org_mhw',
                organizationName: 'MHW Works',
                organizationSlug: 'mhw-works',
              },
            ],
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        )
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
    expect(caught!.message).to.include('mhw-works/prod-testing')
  })
})
