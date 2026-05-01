import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {http, HttpResponse} from 'msw'
import {setupServer} from 'msw/node'

import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

/**
 * qfg-kr7.10: whoami must enumerate all org memberships from the per-org
 * token store, mark the active one, and pull role info from
 * /api/v1/me/organizations. Falls back gracefully when the role endpoint
 * is unreachable so whoami is never bricked by a transient network error.
 */

const tokensPath = () => {
  const home = process.env.QUONFIG_CONFIG_HOME
  if (!home) throw new Error('QUONFIG_CONFIG_HOME unset')
  return path.join(home, 'tokens.json')
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

const orgsHandler = http.post('https://app.quonfig.com/api/v1/me/organizations', () =>
  HttpResponse.json({
    json: [
      {workosOrgId: 'org_acme_uuid', slug: 'acme', name: 'Acme', role: 'admin'},
      {workosOrgId: 'org_beta_uuid', slug: 'beta', name: 'Beta', role: 'member'},
    ],
  }),
)

const orgsErrorHandler = http.post('https://app.quonfig.com/api/v1/me/organizations', () =>
  HttpResponse.json({error: 'Internal'}, {status: 500}),
)

const server = setupServer(orgsHandler)

describe('whoami — kr7.10 multi-org', () => {
  let originalTokens: string | undefined
  let originalQuonfigWorkspace: string | undefined

  before(() => {
    setupTestAuth()
    server.listen()
    originalTokens = fs.readFileSync(tokensPath(), 'utf8')
  })

  afterEach(() => {
    server.resetHandlers(orgsHandler)
    if (originalTokens !== undefined) fs.writeFileSync(tokensPath(), originalTokens)
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
        defaultOrgId: 'org_acme_uuid',
        tokensByOrg: {
          org_acme_uuid: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_acme',
            user_email: 'multi@example.com',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta_uuid: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_beta',
            user_email: 'multi@example.com',
            org_slug: 'beta',
            org_name: 'Beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['whoami'])
    .it('lists all orgs with role from me.organizations and marks the default org active', (ctx) => {
      expect(ctx.stdout).to.contain('Logged in as: multi@example.com')
      expect(ctx.stdout).to.contain('Orgs:')
      // Specific mechanism: the active marker (*) must be on the org that
      // matches defaultOrgId, not just the first row alphabetically.
      const acmeLine = ctx.stdout.split('\n').find((l) => l.includes('acme'))
      const betaLine = ctx.stdout.split('\n').find((l) => l.includes('beta'))
      expect(acmeLine, 'acme line present').to.exist
      expect(betaLine, 'beta line present').to.exist
      expect(acmeLine!).to.match(/^\s*\*\s/)
      expect(acmeLine!).to.contain('(active)')
      expect(acmeLine!).to.contain('admin')
      expect(betaLine!).to.match(/^\s{3,} /)
      expect(betaLine!).to.contain('member')
    })

  test
    .stdout()
    .do(() => {
      const store = {
        defaultOrgId: 'org_acme_uuid',
        tokensByOrg: {
          org_acme_uuid: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_acme',
            user_email: 'multi@example.com',
            org_slug: 'acme',
            org_name: 'Acme',
          },
          org_beta_uuid: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_beta',
            user_email: 'multi@example.com',
            org_slug: 'beta',
            org_name: 'Beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
      originalQuonfigWorkspace = process.env.QUONFIG_WORKSPACE
      process.env.QUONFIG_WORKSPACE = 'beta/anything'
    })
    .command(['whoami'])
    .it('marks the org from QUONFIG_WORKSPACE active, overriding defaultOrgId', (ctx) => {
      // Specific mechanism: the active marker shifts to beta when
      // QUONFIG_WORKSPACE points at beta/* — proves the env-var override
      // wins over defaultOrgId.
      const lines = ctx.stdout.split('\n')
      const acmeLine = lines.find((l) => l.includes('acme'))
      const betaLine = lines.find((l) => l.includes('beta'))
      expect(betaLine!).to.match(/^\s*\*\s/)
      expect(betaLine!).to.contain('(active)')
      expect(acmeLine!).to.not.contain('(active)')
    })

  test
    .stdout()
    .do(() => {
      server.resetHandlers(orgsErrorHandler)
      const store = {
        defaultOrgId: 'org_acme_uuid',
        tokensByOrg: {
          org_acme_uuid: {
            access_token: buildJwt(),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_acme',
            user_email: 'multi@example.com',
            org_slug: 'acme',
            org_name: 'Acme',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['whoami'])
    .it('falls back to local cache when me.organizations is unreachable', (ctx) => {
      // Specific mechanism: the command must still complete (no throw) and
      // show the locally-cached slug. Role degrades to "—" because the
      // server didn't supply one.
      expect(ctx.stdout).to.contain('Logged in as: multi@example.com')
      expect(ctx.stdout).to.contain('acme')
      expect(ctx.stdout).to.contain('—')
    })

  test
    .stdout()
    .do(() => {
      const empty = {tokensByOrg: {}}
      fs.writeFileSync(tokensPath(), JSON.stringify(empty, null, 2))
    })
    .command(['whoami'])
    .it('reports not-logged-in when the token store is empty', (ctx) => {
      expect(ctx.stdout).to.contain('Not logged in')
      expect(ctx.stdout).to.contain('qfg login')
    })
})
