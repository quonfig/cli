import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import {http, HttpResponse} from 'msw'
import {setupServer} from 'msw/node'

import {cleanupTestAuth, setupTestAuth, testConfigPath, testTokensPath} from '../test-auth-helper.js'
import {getApiBase} from '../test-domain-helper.js'

/**
 * qfg-kr7.8: `qfg workspace` must show the active org/workspace, the saved
 * default profile (also as org/ws), the list of orgs with cached tokens,
 * and every (org, workspace) pair the user can reach. Replaces the
 * single-line "Workspace: <slug>" output that lacked org context.
 */

const tokensPath = testTokensPath
const configPath = testConfigPath

/**
 * `orgId` is stamped into the payload so the mock list endpoint can scope
 * its answer the way the real one does (a given org's JWT only ever sees
 * that org's workspaces). `expired` flips `exp` into the past, which is
 * what sends getValidAccessToken down the WorkOS refresh path (qfg-t15h).
 */
const buildJwt = (opts: {expired?: boolean; orgId?: string} = {}) => {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      email: 'multi@example.com',
      exp: opts.expired ? now - 3600 : now + 3600,
      iat: now - 7200,
      org_id: opts.orgId,
      sub: 'user_test',
    }),
  ).toString('base64url')
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
}

const orgIdFromJwt = (jwt: string): string | undefined => {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8')).org_id
  } catch {
    return undefined
  }
}

/** WorkOS refresh endpoint — the org-scoped refresh in oauth-client.ts. */
const WORKOS_AUTHENTICATE = 'https://api.workos.com/user_management/authenticate'

/** The exact failure from the qfg-t15h repro: a server-terminated session. */
const invalidGrantHandler = http.post(WORKOS_AUTHENTICATE, () =>
  HttpResponse.json({error: 'invalid_grant', error_description: 'Session has already ended'}, {status: 400}),
)

const workspacesResponse = {
  json: [
    {
      workspaceId: 'ws-acme-prod',
      workspaceSlug: 'production',
      workosOrgId: 'org_acme',
      organizationSlug: 'acme',
      organizationName: 'Acme',
    },
    {
      workspaceId: 'ws-acme-stg',
      workspaceSlug: 'staging',
      workosOrgId: 'org_acme',
      organizationSlug: 'acme',
      organizationName: 'Acme',
    },
    {
      workspaceId: 'ws-beta-main',
      workspaceSlug: 'main',
      workosOrgId: 'org_beta',
      organizationSlug: 'beta',
      organizationName: 'Beta',
    },
  ],
}

// Scope the answer to the presenting token's org, like the real endpoint —
// otherwise one healthy org's response would paper over another org's dead
// session and the mixed-failure case below could not be observed.
const wsHandler = http.post(`${getApiBase()}/api/v1/userWorkspaces/list`, ({request}) => {
  const jwt = (request.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '')
  const orgId = orgIdFromJwt(jwt)
  const list = orgId ? workspacesResponse.json.filter((w) => w.workosOrgId === orgId) : workspacesResponse.json
  return HttpResponse.json({json: list})
})
const server = setupServer(wsHandler)

describe('workspace — kr7.8 multi-org status', () => {
  let originalTokens: string | undefined
  let originalConfig: string | undefined
  let originalQuonfigWorkspace: string | undefined

  before(() => {
    setupTestAuth()
    server.listen()
    originalTokens = fs.readFileSync(tokensPath(), 'utf8')
    originalConfig = fs.readFileSync(configPath(), 'utf8')
  })

  afterEach(() => {
    server.resetHandlers(wsHandler)
    if (originalTokens !== undefined) fs.writeFileSync(tokensPath(), originalTokens)
    if (originalConfig !== undefined) fs.writeFileSync(configPath(), originalConfig)
    if (originalQuonfigWorkspace === undefined) delete process.env.QUONFIG_WORKSPACE
    else process.env.QUONFIG_WORKSPACE = originalQuonfigWorkspace
    originalQuonfigWorkspace = undefined
  })

  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .do(() => {
      const store = {
        defaultOrgId: 'org_acme',
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt({orgId: 'org_acme'}),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta: {
            access_token: buildJwt({orgId: 'org_beta'}),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_b',
            org_slug: 'beta',
            org_name: 'Beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
      fs.writeFileSync(
        configPath(),
        `default_profile = default

[profile default]
workspace = ws-acme-prod # Acme - production
workspace_slug = production
organization_name = Acme

`,
      )
    })
    .command(['workspace'])
    .it('shows active org/ws, default profile org/ws, and groups workspaces by org', (ctx) => {
      // Specific mechanism: every workspace pin must include the org slug,
      // the default profile must be marked, and the orgs-with-tokens list
      // must be alphabetical and slug-only (proves we read org_slug from
      // the per-org token store rather than printing workosOrgId).
      expect(ctx.stdout).to.contain('Active workspace: acme/production')
      expect(ctx.stdout).to.contain('Default profile:  acme/production')
      expect(ctx.stdout).to.contain('Orgs with tokens: acme, beta')
      expect(ctx.stdout).to.contain('  acme:')
      expect(ctx.stdout).to.contain('    - acme/production (default)')
      expect(ctx.stdout).to.contain('    - acme/staging')
      expect(ctx.stdout).to.contain('  beta:')
      expect(ctx.stdout).to.contain('    - beta/main')
      // Sanity: must NOT print bare slug without org prefix.
      expect(ctx.stdout).to.not.match(/^Workspace:\s+production$/m)
    })

  test
    .stdout()
    .do(() => {
      const store = {
        defaultOrgId: 'org_acme',
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt({orgId: 'org_acme'}),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta: {
            access_token: buildJwt({orgId: 'org_beta'}),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_b',
            org_slug: 'beta',
            org_name: 'Beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
      fs.writeFileSync(
        configPath(),
        `default_profile = default

[profile default]
workspace = ws-acme-prod # Acme - production
workspace_slug = production
organization_name = Acme

`,
      )
      originalQuonfigWorkspace = process.env.QUONFIG_WORKSPACE
      process.env.QUONFIG_WORKSPACE = 'beta/main'
    })
    .command(['workspace'])
    .it('QUONFIG_WORKSPACE overrides the default profile for "Active workspace"', (ctx) => {
      // Specific mechanism: env var changes ACTIVE only; default stays put.
      expect(ctx.stdout).to.contain('Active workspace: beta/main')
      expect(ctx.stdout).to.contain('Default profile:  acme/production')
    })

  /**
   * qfg-t15h: with a dead session, `qfg workspace` used to swallow the
   * refresh failure per org and render the resulting empty list as
   * "(no workspaces yet — `qfg workspace create` to add one)" — telling a
   * user with a valid account that they have nothing and nudging them to
   * create a duplicate workspace. `qfg pull`/`qfg get` get this right; this
   * command must too.
   */
  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(invalidGrantHandler)
      const store = {
        defaultOrgId: 'org_acme',
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt({expired: true, orgId: 'org_acme'}),
            expires_at: Date.now() - 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta: {
            access_token: buildJwt({expired: true, orgId: 'org_beta'}),
            expires_at: Date.now() - 3_600_000,
            refresh_token: 'r_b',
            org_slug: 'beta',
            org_name: 'Beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace'])
    .catch((error: {oclif?: {exit?: number}} & Error) => {
      expect(error.message).to.contain('Session expired')
      expect(error.message).to.contain('qfg login')
      expect(error.oclif?.exit).to.equal(401)
    })
    .it('errors with the session-expired message when every org fails auth (qfg-t15h)', (ctx) => {
      // The whole point of the bead: no "you have no workspaces" lie, and
      // no nudge toward creating a duplicate one.
      expect(ctx.stdout).to.not.contain('no workspaces yet')
      expect(ctx.stdout).to.not.contain('workspace create')
    })

  test
    .stdout()
    .stderr()
    .do(() => {
      // Only acme's session is dead; beta still refreshes/lists fine.
      server.use(invalidGrantHandler)
      const store = {
        defaultOrgId: 'org_beta',
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt({expired: true, orgId: 'org_acme'}),
            expires_at: Date.now() - 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta: {
            access_token: buildJwt({orgId: 'org_beta'}),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_b',
            org_slug: 'beta',
            org_name: 'Beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
      fs.writeFileSync(configPath(), 'default_profile = default\n\n[profile default]\nworkspace = ws-beta-main\n\n')
    })
    .command(['workspace'])
    .it('lists healthy orgs and warns per failed org when only some fail auth (qfg-t15h)', (ctx) => {
      // Multi-org isolation is deliberate (workspace.ts:121-124): one dead
      // org must not blank out the others...
      expect(ctx.stdout).to.contain('    - beta/main')
      // ...but the dead one must not masquerade as an empty org either.
      expect(ctx.stdout).to.not.contain('no workspaces yet')
      expect(ctx.stderr).to.contain('acme')
      expect(ctx.stderr).to.contain('qfg login')
    })

  test
    .stderr()
    .do(() => {
      const empty = {tokensByOrg: {}}
      fs.writeFileSync(tokensPath(), JSON.stringify(empty, null, 2))
    })
    .command(['workspace'])
    .catch((error: Error) => {
      expect(error.message).to.contain('Not logged in')
      expect(error.message).to.contain('qfg login')
    })
    .it('errors when no tokens are cached')
})
