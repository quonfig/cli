import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {http, HttpResponse} from 'msw'
import {setupServer} from 'msw/node'

import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

/**
 * qfg-kr7.8: `qfg workspace` must show the active org/workspace, the saved
 * default profile (also as org/ws), the list of orgs with cached tokens,
 * and every (org, workspace) pair the user can reach. Replaces the
 * single-line "Workspace: <slug>" output that lacked org context.
 */

const tokensPath = () => {
  const home = process.env.QUONFIG_CONFIG_HOME
  if (!home) throw new Error('QUONFIG_CONFIG_HOME unset')
  return path.join(home, 'tokens.json')
}

const configPath = () => {
  const home = process.env.QUONFIG_CONFIG_HOME
  if (!home) throw new Error('QUONFIG_CONFIG_HOME unset')
  return path.join(home, 'config')
}

const buildJwt = () => {
  const payload = Buffer.from(
    JSON.stringify({
      email: 'multi@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub: 'user_test',
    }),
  ).toString('base64url')
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
}

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

const wsHandler = http.post('https://app.quonfig.com/api/v1/userWorkspaces/list', () =>
  HttpResponse.json(workspacesResponse),
)
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
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta: {
            access_token: buildJwt(),
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
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta: {
            access_token: buildJwt(),
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
