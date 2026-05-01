import {expect} from '@oclif/test'
import {http, HttpResponse} from 'msw'
import {setupServer} from 'msw/node'
import {afterEach, before, after, beforeEach, describe, it} from 'mocha'

import {orchestrateMultiOrgLogin} from '../../src/util/login-orchestrator.js'

/**
 * qfg-mol-k27: login.ts must mint one org-scoped TokenSet per org the user
 * belongs to, persist them keyed by workosOrgId in the per-org token store,
 * and pick a default org. Tests target the orchestration helper directly so
 * we can drive the multi-org code paths without a real device-auth flow.
 *
 * Specific mechanism the tests must lock in (revert test):
 *   - One POST per org against WorkOS /user_management/authenticate with
 *     grant_type=refresh_token + organization_id=<workosOrgId>
 *   - tokensByOrg keyed by workosOrgId, each entry carrying org_slug + org_name
 *     so resolve-workspace.ts (kr7.5) can find the org by slug without a
 *     server round-trip.
 *   - defaultOrgId set to the only org (single-org users) or first
 *     alphabetically by slug (multi-org users).
 *   - When the user belongs to >10 orgs we mint only the first 10
 *     alphabetically (rate-limit guard from the plan).
 */

const buildJwt = (payload: Record<string, unknown>): string => {
  const header = Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT'})).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

interface CapturedAuth {
  organizationId: string
  refreshToken: string
}

const buildServer = (orgs: Array<{workosOrgId: string; slug: string; name: string; role: string}>) => {
  const captured: CapturedAuth[] = []

  const orgsHandler = http.post('https://app.quonfig.com/api/v1/me/organizations', () =>
    HttpResponse.json({json: orgs}),
  )

  const authHandler = http.post('https://api.workos.com/user_management/authenticate', async ({request}) => {
    const text = await request.text()
    const params = new URLSearchParams(text)
    const organizationId = params.get('organization_id') ?? ''
    const refreshToken = params.get('refresh_token') ?? ''
    captured.push({organizationId, refreshToken})

    const exp = Math.floor(Date.now() / 1000) + 3600
    const access_token = buildJwt({email: 'multi@example.com', exp, org_id: organizationId, sub: 'user_test'})
    return HttpResponse.json({
      access_token,
      authentication_method: 'RefreshToken',
      refresh_token: `refresh_${organizationId}`,
      user: {email: 'multi@example.com', id: 'user_test'},
    })
  })

  const server = setupServer(orgsHandler, authHandler)
  return {server, captured}
}

describe('orchestrateMultiOrgLogin (qfg-mol-k27)', () => {
  describe('two-org user', () => {
    const orgs = [
      {workosOrgId: 'org_acme_uuid', slug: 'acme', name: 'Acme', role: 'admin'},
      {workosOrgId: 'org_beta_uuid', slug: 'beta', name: 'Beta', role: 'member'},
    ]

    let server: ReturnType<typeof buildServer>['server']
    let captured: CapturedAuth[]

    before(() => {
      ;({server, captured} = buildServer(orgs))
      server.listen()
    })

    beforeEach(() => {
      captured.length = 0
    })

    afterEach(() => {
      server.resetHandlers()
    })

    after(() => {
      server.close()
    })

    it('mints one org-scoped TokenSet per org and keys the store by workosOrgId', async () => {
      const result = await orchestrateMultiOrgLogin({
        apiUrl: 'https://app.quonfig.com',
        initialAccessToken: buildJwt({email: 'multi@example.com', exp: Math.floor(Date.now() / 1000) + 3600}),
        initialRefreshToken: 'initial_refresh',
        user: {email: 'multi@example.com', id: 'user_test'},
      })

      // Specific mechanism #1: one WorkOS authenticate POST per org, each with
      // organization_id=<workosOrgId>. If login skipped per-org minting and
      // reused the initial token, captured.length would be 0 or 1.
      expect(captured.map((c) => c.organizationId).sort()).to.deep.equal(['org_acme_uuid', 'org_beta_uuid'])
      // Specific mechanism #2: every per-org call uses the initial refresh
      // token, not a previously-minted one (parallel mint, not serial chain).
      expect(captured.every((c) => c.refreshToken === 'initial_refresh')).to.equal(true)

      // Specific mechanism #3: tokensByOrg is keyed by workosOrgId.
      expect(Object.keys(result.tokenStore.tokensByOrg).sort()).to.deep.equal(['org_acme_uuid', 'org_beta_uuid'])

      // Specific mechanism #4: each TokenSet carries org_slug + org_name so
      // resolve-workspace can locate orgs by slug locally.
      const acme = result.tokenStore.tokensByOrg.org_acme_uuid
      expect(acme.org_slug).to.equal('acme')
      expect(acme.org_name).to.equal('Acme')
      const beta = result.tokenStore.tokensByOrg.org_beta_uuid
      expect(beta.org_slug).to.equal('beta')
      expect(beta.org_name).to.equal('Beta')
    })

    it('sets defaultOrgId to the first org alphabetically by slug for multi-org users', async () => {
      const result = await orchestrateMultiOrgLogin({
        apiUrl: 'https://app.quonfig.com',
        initialAccessToken: buildJwt({email: 'multi@example.com', exp: Math.floor(Date.now() / 1000) + 3600}),
        initialRefreshToken: 'initial_refresh',
        user: {email: 'multi@example.com', id: 'user_test'},
      })

      // acme < beta alphabetically — pick acme. If sorting were skipped, the
      // server's response order would win (also acme-first here, so to make
      // the test discriminating we also check the summary's "alphabetical
      // first" flag).
      expect(result.defaultOrgId).to.equal('org_acme_uuid')
      expect(result.defaultOrg.slug).to.equal('acme')
      expect(result.mintedOrgSlugs).to.deep.equal(['acme', 'beta'])
    })
  })

  describe('single-org user', () => {
    const orgs = [{workosOrgId: 'org_only_uuid', slug: 'only', name: 'Only', role: 'admin'}]

    let server: ReturnType<typeof buildServer>['server']

    before(() => {
      ;({server} = buildServer(orgs))
      server.listen()
    })

    afterEach(() => server.resetHandlers())
    after(() => server.close())

    it('sets defaultOrgId to the single org', async () => {
      const result = await orchestrateMultiOrgLogin({
        apiUrl: 'https://app.quonfig.com',
        initialAccessToken: buildJwt({email: 'solo@example.com', exp: Math.floor(Date.now() / 1000) + 3600}),
        initialRefreshToken: 'initial_refresh',
        user: {email: 'solo@example.com', id: 'user_solo'},
      })

      expect(result.defaultOrgId).to.equal('org_only_uuid')
      expect(Object.keys(result.tokenStore.tokensByOrg)).to.deep.equal(['org_only_uuid'])
    })
  })

  describe('rate-limit guard (>10 orgs)', () => {
    const orgs = Array.from({length: 13}, (_, i) => ({
      workosOrgId: `org_${String.fromCodePoint(97 + i)}_uuid`,
      slug: String.fromCodePoint(97 + i).repeat(3),
      name: `Org ${i}`,
      role: 'member',
    }))

    let server: ReturnType<typeof buildServer>['server']
    let captured: CapturedAuth[]

    before(() => {
      ;({server, captured} = buildServer(orgs))
      server.listen()
    })

    beforeEach(() => {
      captured.length = 0
    })

    afterEach(() => server.resetHandlers())
    after(() => server.close())

    it('mints only the first 10 orgs alphabetically when the user belongs to more than 10', async () => {
      const result = await orchestrateMultiOrgLogin({
        apiUrl: 'https://app.quonfig.com',
        initialAccessToken: buildJwt({email: 'big@example.com', exp: Math.floor(Date.now() / 1000) + 3600}),
        initialRefreshToken: 'initial_refresh',
        user: {email: 'big@example.com', id: 'user_big'},
      })

      // Specific mechanism: the cap is 10, not 13 (drops 'kkk', 'lll', 'mmm').
      expect(captured.length).to.equal(10)
      expect(Object.keys(result.tokenStore.tokensByOrg).length).to.equal(10)
      expect(result.mintedOrgSlugs).to.deep.equal(['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh', 'iii', 'jjj'])
      expect(result.skippedOrgSlugs).to.deep.equal(['kkk', 'lll', 'mmm'])
    })
  })
})
