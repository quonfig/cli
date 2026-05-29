import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {
  __resetSleepForTests,
  __setSleepForTests,
  fetchAllChangeHistory,
  fetchChangeHistoryPage,
  fetchEnvironments,
  setLaunchBaseUrl,
} from '../../src/migrate/sources/launch/api.js'

const TEST_BASE_URL = 'https://api.launch.test'

/** Cloudflare-style edge block: HTML body, not the app's JSON error shape. */
const EDGE_403_HTML = '<!doctype html><meta charset="utf-8"><title>403</title>403 Forbidden'

const envsResponse = {
  envs: [
    {id: 148, name: 'Production'},
    {id: 149, name: 'Staging'},
  ],
  projectId: 1,
}

describe('migrate/sources/launch/api', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setLaunchBaseUrl(TEST_BASE_URL)
    // No-op sleep so backoff waits don't slow the suite.
    __setSleepForTests(async () => {})
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
  })

  describe('fetchEnvironments', () => {
    it('maps environment id (as string) → name', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, ({request}) => {
          const auth = request.headers.get('Authorization')
          expect(auth).to.match(/^Basic /)
          return HttpResponse.json(envsResponse)
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const map = await fetchEnvironments('test-api-key')
      expect(map).to.deep.equal({148: 'Production', 149: 'Staging'})
    })
  })

  describe('fetchChangeHistoryPage', () => {
    it('sends cursor and expected query params', async () => {
      let capturedUrl = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, ({request}) => {
          capturedUrl = request.url
          return HttpResponse.json({changes: [], cursor: undefined})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchChangeHistoryPage('test-api-key', 'some-cursor')

      const u = new URL(capturedUrl)
      expect(u.searchParams.get('cursor')).to.equal('some-cursor')
      expect(u.searchParams.get('includeNewVersion')).to.equal('true')
      expect(u.searchParams.get('includeSummary')).to.equal('true')
      expect(u.searchParams.get('expands')).to.equal('changedBy')
      expect(u.searchParams.get('limit')).to.equal('50')
    })
  })

  describe('fetchAllChangeHistory', () => {
    it('paginates using returned cursor and returns oldest→newest order', async () => {
      const page1 = {
        changes: [
          {
            changedAt: 300,
            changedBy: {id: 'u1', email: 'a@b', type: 'user'},
            deleted: false,
            key: 'k3',
            newConfigId: 3,
            type: 'FEATURE_FLAG',
          },
          {
            changedAt: 200,
            changedBy: {id: 'u1', email: 'a@b', type: 'user'},
            deleted: false,
            key: 'k2',
            newConfigId: 2,
            type: 'FEATURE_FLAG',
          },
        ],
        cursor: '200:k2',
      }
      const page2 = {
        changes: [
          {
            changedAt: 100,
            changedBy: {id: 'u1', email: 'a@b', type: 'user'},
            deleted: false,
            key: 'k1',
            newConfigId: 1,
            type: 'FEATURE_FLAG',
          },
        ],
      }

      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, ({request}) => {
          const u = new URL(request.url)
          return HttpResponse.json(u.searchParams.get('cursor') === '200:k2' ? page2 : page1)
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const changes = await fetchAllChangeHistory('test-api-key')

      expect(changes).to.have.length(3)
      expect(changes.map((c) => c.changedAt)).to.deep.equal([100, 200, 300])
    })

    it('stops pagination when a change at or before sinceEpochMs is reached (delta cursor stop)', async () => {
      const page1 = {
        changes: [
          {
            changedAt: 300,
            changedBy: {id: 'u1', email: 'a@b', type: 'user'},
            deleted: false,
            key: 'k3',
            newConfigId: 3,
            type: 'FEATURE_FLAG',
          },
          {
            changedAt: 250,
            changedBy: {id: 'u1', email: 'a@b', type: 'user'},
            deleted: false,
            key: 'k2.5',
            newConfigId: 25,
            type: 'FEATURE_FLAG',
          },
          {
            changedAt: 200,
            changedBy: {id: 'u1', email: 'a@b', type: 'user'},
            deleted: false,
            key: 'k2',
            newConfigId: 2,
            type: 'FEATURE_FLAG',
          },
        ],
        cursor: '200:k2',
      }
      let page2Requested = false
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, ({request}) => {
          const u = new URL(request.url)
          if (u.searchParams.get('cursor') === '200:k2') {
            page2Requested = true
            return HttpResponse.json({
              changes: [
                {
                  changedAt: 100,
                  changedBy: {id: 'u1', email: 'a@b', type: 'user'},
                  deleted: false,
                  key: 'k1',
                  newConfigId: 1,
                  type: 'FEATURE_FLAG',
                },
              ],
            })
          }

          return HttpResponse.json(page1)
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const changes = await fetchAllChangeHistory('test-api-key', 200)

      expect(page2Requested, 'page 2 must NOT be fetched once cursor is reached').to.equal(false)
      expect(changes.map((c) => c.changedAt)).to.deep.equal([250, 300])
    })

    it('breaks when the API returns a cursor it has already returned (cycle protection)', async () => {
      let calls = 0
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () => {
          calls++
          return HttpResponse.json({
            changes: [
              {
                changedAt: calls * 100,
                changedBy: {id: 'u1', email: 'a@b', type: 'user'},
                deleted: false,
                key: `k${calls}`,
                newConfigId: calls,
                type: 'FEATURE_FLAG',
              },
            ],
            cursor: 'stuck',
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const changes = await fetchAllChangeHistory('test-api-key')
      expect(calls).to.be.lessThan(5, 'must stop after detecting cursor cycle')
      expect(changes.length).to.be.greaterThan(0)
    })

    it('reports cumulative fetched counts to onProgress after each page', async () => {
      const mkChange = (changedAt: number, key: string) => ({
        changedAt,
        changedBy: {id: 'u1', email: 'a@b', type: 'user'},
        deleted: false,
        key,
        newConfigId: changedAt,
        type: 'FEATURE_FLAG',
      })
      const page1 = {changes: [mkChange(300, 'k3'), mkChange(200, 'k2')], cursor: '200:k2'}
      const page2 = {changes: [mkChange(100, 'k1')]}

      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, ({request}) => {
          const u = new URL(request.url)
          return HttpResponse.json(u.searchParams.get('cursor') === '200:k2' ? page2 : page1)
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const progress: number[] = []
      const changes = await fetchAllChangeHistory('test-api-key', undefined, (fetched) => progress.push(fetched))

      expect(changes).to.have.length(3)
      // One callback per page, each carrying the running cumulative total.
      expect(progress).to.deep.equal([2, 3])
    })
  })

  describe('edge rate-limit handling', () => {
    const okPage = {changes: [], cursor: undefined}

    it('retries an HTML 403 edge-block (Cloudflare-style) then succeeds', async () => {
      let calls = 0
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () => {
          calls++
          if (calls < 3) {
            return new HttpResponse(EDGE_403_HTML, {
              headers: {'Content-Type': 'text/html'},
              status: 403,
            })
          }

          return HttpResponse.json(okPage)
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const changes = await fetchAllChangeHistory('test-api-key')
      expect(calls, 'should have retried twice before the 200').to.equal(3)
      expect(changes).to.deep.equal([])
    })

    it('retries a 429 then succeeds', async () => {
      let calls = 0
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () => {
          calls++
          if (calls === 1) return new HttpResponse('rate limited', {status: 429})
          return HttpResponse.json(okPage)
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchAllChangeHistory('test-api-key')
      expect(calls).to.equal(2)
    })

    it('throws immediately on a JSON 403 (real authz error) without retrying', async () => {
      let calls = 0
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () => {
          calls++
          return HttpResponse.json({error: 'forbidden: token lacks read scope'}, {status: 403})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      let threw = false
      try {
        await fetchAllChangeHistory('test-api-key')
      } catch (error) {
        threw = true
        expect((error as Error).message).to.match(/403/)
      }

      expect(threw, 'a JSON 403 must surface immediately').to.equal(true)
      expect(calls, 'an authz 403 must NOT be retried').to.equal(1)
    })

    it('gives up with a clear error after exhausting retries on a persistent HTML 403', async () => {
      let calls = 0
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () => {
          calls++
          return new HttpResponse(EDGE_403_HTML, {
            headers: {'Content-Type': 'text/html'},
            status: 403,
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      let threw = false
      try {
        await fetchAllChangeHistory('test-api-key')
      } catch (error) {
        threw = true
        expect((error as Error).message).to.match(/403/)
      }

      expect(threw).to.equal(true)
      // Initial attempt + MAX_RETRIES (6) = 7 total.
      expect(calls).to.equal(7)
    })
  })
})
