import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {
  fetchAllChangeHistory,
  fetchChangeHistoryPage,
  fetchEnvironments,
  setLaunchBaseUrl,
} from '../../src/migrate/sources/launch/api.js'

const TEST_BASE_URL = 'https://api.launch.test'

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
  })

  afterEach(() => {
    if (server) server.close()
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
  })
})
