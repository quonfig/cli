import {expect, test} from '@oclif/test'
import {http, HttpResponse} from 'msw'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {resetClientCache} from '../../../src/util/get-client.js'
import {conflictHandler, multiOrgHandler, server, unauthorizedHandler} from '../../responses/workspace-create.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

// Subcommands with topicSeparator=' ' must be passed as a single id string.
// See sdk-key.test.ts for the same pattern.

describe('workspace create', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['workspace create', 'lt-21-smoke'])
    .it('prints the new workspace on 201 success', (ctx) => {
      expect(ctx.stdout).to.contain('Workspace created.')
      expect(ctx.stdout).to.contain('ws-uuid-new')
      expect(ctx.stdout).to.contain('lt-21-smoke')
      expect(ctx.stdout).to.contain('test-organization')
      expect(ctx.stdout).to.contain('production')
      expect(ctx.stdout).to.contain('staging')
      expect(ctx.stdout).to.contain('development')
    })

  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(conflictHandler)
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('already exists')
      expect(error.message).to.contain('Pick a different slug')
    })
    .it('reports 409 slug collision with a helpful suggestion')

  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(unauthorizedHandler)
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('Authentication')
      expect(error.message).to.contain('qfg login')
    })
    .it('reports 401 with a login hint')

  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(multiOrgHandler)
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('more than one organization')
      expect(error.message).to.contain('--org')
    })
    .it('reports 400 multi-org with --org guidance')
})

/**
 * qfg-kr7.7: workspace create must pick the org from the per-org token store.
 *
 * 1 org → auto-select.
 * 2+ orgs → require `--org`; bare command errors with the list of orgs.
 * 0 orgs → error with `qfg login` instructions.
 *
 * Each test rewrites the tokens.json fixture in QUONFIG_CONFIG_HOME so the
 * `loadTokens()` call inside the command sees the multi-org shape it needs.
 */
describe('workspace create — kr7.7 multi-org token resolution', () => {
  let originalTokens: string | undefined
  const buildJwt = (expSecondsFromNow: number) => {
    const payload = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user_test',
      }),
    ).toString('base64url')
    return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
  }

  const tokensPath = () => {
    const home = process.env.QUONFIG_CONFIG_HOME
    if (!home) throw new Error('QUONFIG_CONFIG_HOME unset — setupTestAuth must run before this test')
    return path.join(home, 'tokens.json')
  }

  before(() => {
    setupTestAuth()
    server.listen()
    originalTokens = fs.readFileSync(tokensPath(), 'utf8')
  })

  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    if (originalTokens !== undefined) {
      fs.writeFileSync(tokensPath(), originalTokens)
    }
  })

  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .do(() => {
      const store = {
        defaultOrgId: 'org_workspace-123',
        tokensByOrg: {
          'org_workspace-123': {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'mock-refresh-token',
            org_slug: 'test-organization',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace create', 'lt-21-smoke'])
    .it('1 org: auto-selects and prints the active org slug', (ctx) => {
      // Specific mechanism: the command must announce the auto-selected org.
      expect(ctx.stdout).to.contain('Creating workspace in org: test-organization')
      expect(ctx.stdout).to.contain('Workspace created.')
    })

  test
    .stdout()
    .stderr()
    .do(() => {
      const store = {
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
          },
          org_beta: {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_b',
            org_slug: 'beta',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('multiple orgs')
      expect(error.message).to.contain('--org')
      expect(error.message).to.contain('acme')
      expect(error.message).to.contain('beta')
    })
    .it('2+ orgs without --org: lists orgs and instructs user to specify --org')

  test
    .stdout()
    .do(() => {
      const store = {
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
          },
          'org_workspace-123': {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'mock-refresh-token',
            org_slug: 'test-organization',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace create', 'lt-21-smoke', '--org', 'test-organization'])
    .it('2+ orgs with --org slug: resolves slug to workosOrgId and creates', (ctx) => {
      expect(ctx.stdout).to.contain('Creating workspace in org: test-organization')
      expect(ctx.stdout).to.contain('Workspace created.')
    })

  test
    .stdout()
    .stderr()
    .do(() => {
      const store = {
        tokensByOrg: {
          org_acme: {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'r_a',
            org_slug: 'acme',
          },
          'org_workspace-123': {
            access_token: buildJwt(3600),
            expires_at: Date.now() + 3_600_000,
            refresh_token: 'mock-refresh-token',
            org_slug: 'test-organization',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
    })
    .command(['workspace create', 'lt-21-smoke', '--org', 'unknown-org'])
    .catch((error: Error) => {
      expect(error.message).to.contain('unknown-org')
      expect(error.message).to.contain('not found in your token store')
      expect(error.message).to.contain('qfg login')
    })
    .it('--org slug not in token store: errors with refresh hint')

  test
    .stdout()
    .stderr()
    .do(() => {
      const empty = {tokensByOrg: {}}
      fs.writeFileSync(tokensPath(), JSON.stringify(empty, null, 2))
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('No orgs found')
      expect(error.message).to.contain('qfg login')
    })
    .it('0 orgs in token store: errors with login hint')

  // qfg-5ee9: an expired access_token + stale refresh_token used to surface
  // the same "Not logged in" message as a fresh user with no tokens at all,
  // burying the real diagnostic ("invalid_grant — Refresh token already
  // exchanged"). This test pins the underlying detail to the user-facing
  // error so future regressions show up red.
  test
    .stdout()
    .stderr()
    .do(() => {
      const pastSeconds = Math.floor(Date.now() / 1000) - 3600
      const expiredJwtPayload = Buffer.from(
        JSON.stringify({exp: pastSeconds, iat: pastSeconds - 3600, sub: 'user_test'}),
      ).toString('base64url')
      const expiredJwt = `eyJhbGciOiJSUzI1NiJ9.${expiredJwtPayload}.sig`
      const store = {
        defaultOrgId: 'org_workspace-123',
        tokensByOrg: {
          'org_workspace-123': {
            access_token: expiredJwt,
            expires_at: pastSeconds * 1000,
            refresh_token: 'mock-stale-refresh-token',
            org_slug: 'test-organization',
          },
        },
      }
      fs.writeFileSync(tokensPath(), JSON.stringify(store, null, 2))
      server.use(
        http.post('https://api.workos.com/user_management/authenticate', () =>
          HttpResponse.text('invalid_grant: Refresh token already exchanged', {status: 400}),
        ),
      )
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('Token refresh failed')
      expect(error.message).to.contain('invalid_grant')
      expect(error.message).to.contain('qfg login')
    })
    .it('surfaces token refresh failure detail instead of swallowing to "Not logged in" (qfg-5ee9)')
})
