import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import {http, HttpResponse} from 'msw'
import {setupServer} from 'msw/node'

import {cleanupTestAuth, setupTestAuth, testConfigPath, testTokensPath} from '../../test-auth-helper.js'

/**
 * qfg-kr7.9: `qfg workspace switch` accepts the `<org>/<ws>` pin form,
 * matches by (workosOrgId, workspaceSlug) so two orgs with the same
 * workspace name don't collide, and writes the workosOrgId + slug back
 * into the saved default profile so other commands can pick the right
 * org-scoped token without a round-trip.
 */

const tokensPath = testTokensPath
const configPath = testConfigPath

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

const wsList = {
  json: [
    {
      workspaceId: 'ws-acme-prod',
      workspaceSlug: 'production',
      workosOrgId: 'org_acme',
      organizationSlug: 'acme',
      organizationName: 'Acme',
    },
    {
      workspaceId: 'ws-beta-prod',
      workspaceSlug: 'production',
      workosOrgId: 'org_beta',
      organizationSlug: 'beta',
      organizationName: 'Beta',
    },
  ],
}

const wsHandler = http.post('https://app.quonfig.com/api/v1/userWorkspaces/list', () => HttpResponse.json(wsList))
const server = setupServer(wsHandler)

describe('workspace switch — kr7.9 multi-org pinning', () => {
  let originalTokens: string | undefined
  let originalConfig: string | undefined

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
    })
    .command(['workspace switch', 'beta/production'])
    .it('disambiguates two orgs sharing a workspace slug and persists organization_slug', (ctx) => {
      // Specific mechanism: the saved profile must point at ws-beta-prod
      // and store organization_slug=beta — not the acme entry that has the
      // same workspaceSlug. If the matcher fell back to slug-only it would
      // pick whichever happened to come first. organization_slug is the
      // user-vocabulary identifier downstream commands use to look up the
      // per-org WorkOS token (via findOrgIdBySlug).
      expect(ctx.stdout).to.contain('Switched to: beta/production')
      expect(ctx.stdout).to.contain('QUONFIG_WORKSPACE=beta/production')
      const saved = fs.readFileSync(configPath(), 'utf8')
      expect(saved).to.match(/workspace\s*=\s*ws-beta-prod/)
      expect(saved).to.match(/organization_slug\s*=\s*beta/)
      expect(saved).to.not.match(/workos_org_id/)
    })

  test
    .stderr()
    .do(() => {
      const store = {
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace switch', 'just-bare-slug'])
    .catch((error: Error) => {
      // Specific mechanism: bare slug must produce the migration error,
      // not silently match the first workspace with that slug.
      expect(error.message).to.contain('org-slug')
      expect(error.message).to.contain('workspace-slug')
      expect(error.message).to.contain('Bare workspace slugs are no longer accepted')
    })
    .it('rejects bare slug positional arg with migration message')

  test
    .stderr()
    .do(() => {
      const store = {
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace switch', 'unknown-org/anything'])
    .catch((error: Error) => {
      expect(error.message).to.contain('No token found for org')
      expect(error.message).to.contain('unknown-org')
      expect(error.message).to.contain('qfg login')
    })
    .it('errors when org slug is not in the local token store')
})
