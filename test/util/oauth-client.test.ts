import {expect} from '@oclif/test'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {authenticateWithOrg} from '../../src/util/oauth-client.js'

interface CapturedRequest {
  body?: URLSearchParams
  headers?: Record<string, string>
  method?: string
  url?: string
}

const buildJwt = (payload: Record<string, unknown>): string => {
  const header = Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT'})).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('oauth-client.authenticateWithOrg', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs grant_type=refresh_token + organization_id and returns a TokenSet derived from the JWT exp', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = buildJwt({exp, org_id: 'org_target', sub: 'user_123'})

    const captured: CapturedRequest = {}
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.url = url
      captured.method = init.method
      captured.headers = init.headers as Record<string, string>
      captured.body = new URLSearchParams((init.body as URLSearchParams).toString())
      return {
        json: async () => ({
          access_token: jwt,
          authentication_method: 'RefreshToken',
          refresh_token: 'new_refresh_token_value',
          user: {email: 'foo@bar.com', id: 'user_123'},
        }),
        ok: true,
      } as Response
    }) as typeof globalThis.fetch

    const result = await authenticateWithOrg('old_refresh_token', 'org_target')

    expect(captured.url).to.equal('https://api.workos.com/user_management/authenticate')
    expect(captured.method).to.equal('POST')
    expect(captured.headers?.['Content-Type']).to.equal('application/x-www-form-urlencoded')
    expect(captured.body?.get('grant_type')).to.equal('refresh_token')
    expect(captured.body?.get('organization_id')).to.equal('org_target')
    expect(captured.body?.get('refresh_token')).to.equal('old_refresh_token')
    expect(captured.body?.get('client_id')).to.be.a('string').and.not.equal('')

    expect(result.access_token).to.equal(jwt)
    expect(result.refresh_token).to.equal('new_refresh_token_value')
    expect(result.expires_at).to.equal(exp * 1000)
    expect(result.user_email).to.equal('foo@bar.com')
    expect(result.user_id).to.equal('user_123')
  })

  it('throws a descriptive error when WorkOS returns a non-2xx response', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        text: async () => 'invalid_grant: refresh token revoked',
      }) as Response) as typeof globalThis.fetch

    let caught: Error | undefined
    try {
      await authenticateWithOrg('bad_refresh', 'org_x')
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected authenticateWithOrg to throw').to.exist
    expect(caught!.message).to.include('org_x')
    expect(caught!.message).to.include('invalid_grant')
  })
})
