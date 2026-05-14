/**
 * qfg-3uks Item C — when an API call to mint a Gitea token returns a
 * non-JSON body (e.g. an auth-redirect HTML page or a 404 from a
 * mis-routed request), the user used to see only:
 *
 *   Error: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * Now we wrap the response in a clearer error that names the URL and the
 * HTTP status code, plus a snippet of the body so the user can tell at a
 * glance whether they hit a login page, a 404, or a 5xx.
 */

import {expect} from 'chai'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {mintGiteaToken} from '../../src/util/gitea-api.js'

describe('mintGiteaToken non-JSON response (qfg-3uks Item C)', () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.QUONFIG_API_KEY
  const originalApiOverride = process.env.QUONFIG_API_BASE_URL_OVERRIDE
  const originalDomain = process.env.QUONFIG_DOMAIN

  beforeEach(() => {
    // Short-circuit the WorkOS auth lookup so the test only exercises
    // the fetch + JSON-parse path inside mintGiteaToken.
    process.env.QUONFIG_API_KEY = 'qf_uk_fake_key_for_test'
    process.env.QUONFIG_API_BASE_URL_OVERRIDE = 'https://app.example.test'
    delete process.env.QUONFIG_DOMAIN
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
    else process.env.QUONFIG_API_KEY = originalApiKey
    if (originalApiOverride === undefined) delete process.env.QUONFIG_API_BASE_URL_OVERRIDE
    else process.env.QUONFIG_API_BASE_URL_OVERRIDE = originalApiOverride
    if (originalDomain === undefined) delete process.env.QUONFIG_DOMAIN
    else process.env.QUONFIG_DOMAIN = originalDomain
  })

  const stubFetch = (status: number, body: string, ok = status >= 200 && status < 300) => {
    globalThis.fetch = async () =>
      ({
        ok,
        status,
        async text() {
          return body
        },
        async json() {
          return JSON.parse(body)
        },
      }) as unknown as Response
  }

  it('includes the URL and HTTP status when a 200 returns HTML instead of JSON', async () => {
    stubFetch(200, '<!DOCTYPE html><html><body>login redirect</body></html>')

    let caught: unknown
    try {
      await mintGiteaToken('ws-uuid', 'acme', 'read', 'pull')
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    const message = (caught as Error).message
    expect(message).to.include('/api/v1/gitea/token')
    expect(message).to.include('app.example.test')
    expect(message).to.match(/HTTP 200/)
    expect(message.toLowerCase()).to.include('not valid json')
  })

  it('includes the URL and HTTP status when an error response returns HTML instead of JSON', async () => {
    stubFetch(404, '<!DOCTYPE html><html><body>not found</body></html>')

    let caught: unknown
    try {
      await mintGiteaToken('ws-uuid', 'acme', 'read', 'pull')
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    const message = (caught as Error).message
    expect(message).to.include('/api/v1/gitea/token')
    expect(message).to.match(/HTTP 404/)
  })
})
