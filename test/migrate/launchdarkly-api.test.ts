import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {
  LaunchDarklyApiError,
  __resetSleepForTests,
  __setSleepForTests,
  fetchContextKinds,
  fetchFlags,
  fetchProjectEnvironments,
  fetchSegmentsForEnv,
  fetchSnapshot,
  setLaunchDarklyBaseUrl,
} from '../../src/migrate/sources/launchdarkly/api.js'

const TEST_BASE_URL = 'https://ld.test/api/v2'

describe('migrate/sources/launchdarkly/api', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setLaunchDarklyBaseUrl(TEST_BASE_URL)
    // Swap the real timer-backed sleep for a no-op so 429 backoff tests are instant.
    __setSleepForTests(async () => {})
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
  })

  describe('auth header', () => {
    it('sends the raw API token in Authorization with no Bearer prefix', async () => {
      let capturedAuth = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, ({request}) => {
          capturedAuth = request.headers.get('Authorization') ?? ''
          return HttpResponse.json({items: [{key: 'test', name: 'Test'}]})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchProjectEnvironments('api-xyz-token', 'default')
      expect(capturedAuth).to.equal('api-xyz-token')
    })
  })

  describe('fetchProjectEnvironments', () => {
    it('returns environment keys', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({
            items: [
              {key: 'test', name: 'Test'},
              {key: 'production', name: 'Production'},
            ],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const envs = await fetchProjectEnvironments('k', 'default')
      expect(envs).to.deep.equal(['test', 'production'])
    })

    it('throws LaunchDarklyApiError with the status on a 401', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () => new HttpResponse('nope', {status: 401})),
      )
      server.listen({onUnhandledRequest: 'error'})

      try {
        await fetchProjectEnvironments('bad', 'default')
        expect.fail('expected a throw')
      } catch (error) {
        expect(error).to.be.instanceOf(LaunchDarklyApiError)
        expect((error as LaunchDarklyApiError).status).to.equal(401)
      }
    })
  })

  describe('429 backoff', () => {
    it('retries after a 429 and succeeds, honoring X-Ratelimit-Reset', async () => {
      let calls = 0
      const waited: number[] = []
      __setSleepForTests(async (ms) => {
        waited.push(ms)
      })
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () => {
          calls++
          if (calls === 1) {
            return new HttpResponse('rate limited', {
              headers: {'X-Ratelimit-Reset': String(Date.now() + 1234)},
              status: 429,
            })
          }

          return HttpResponse.json({items: [{key: 'test', name: 'Test'}]})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const envs = await fetchProjectEnvironments('k', 'default')
      expect(calls).to.equal(2)
      expect(envs).to.deep.equal(['test'])
      // The recorded wait must come from the reset header, not the default —
      // proving we program against the header, not a constant.
      expect(waited[0]).to.be.greaterThan(1000)
      expect(waited[0]).to.be.lessThanOrEqual(1234)
    })
  })

  describe('fetchContextKinds', () => {
    it('returns context kind keys', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () =>
          HttpResponse.json({items: [{key: 'user'}, {key: 'organization'}]}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      expect(await fetchContextKinds('k', 'default')).to.deep.equal(['user', 'organization'])
    })
  })

  describe('fetchFlags', () => {
    it('requests summary=0 and one env param per environment, and paginates via _links.next', async () => {
      let firstUrl = ''
      const seenPaths: string[] = []
      const page1Items = Array.from({length: 20}, (_, i) => ({
        environments: {},
        key: `flag-${i}`,
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }))
      server = setupServer(
        http.get(`${TEST_BASE_URL}/flags/default`, ({request}) => {
          const u = new URL(request.url)
          seenPaths.push(u.pathname + u.search)
          if (!u.searchParams.get('offset')) {
            firstUrl = request.url
            return HttpResponse.json({
              _links: {next: {href: '/api/v2/flags/default?offset=20&summary=0'}},
              items: page1Items,
            })
          }

          return HttpResponse.json({items: [{environments: {}, key: 'flag-20', kind: 'boolean', variations: []}]})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const flags = await fetchFlags('k', 'default', ['test', 'production'])
      const u = new URL(firstUrl)
      expect(u.searchParams.get('summary')).to.equal('0')
      expect(u.searchParams.getAll('env')).to.deep.equal(['test', 'production'])
      expect(u.searchParams.get('archived')).to.equal(null)
      expect(flags).to.have.length(21)
      // Page 2 must have been fetched via the _links.next href.
      expect(seenPaths.some((p) => p.includes('offset=20'))).to.equal(true)
    })

    it('sets archived=true only when opts.archived is passed (corpus-exporter pass)', async () => {
      let seenUrl = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/flags/default`, ({request}) => {
          seenUrl = request.url
          return HttpResponse.json({
            items: [{archived: true, environments: {}, key: 'fx-state-archived', kind: 'boolean', variations: []}],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const flags = await fetchFlags('k', 'default', ['test'], {archived: true})
      expect(new URL(seenUrl).searchParams.get('archived')).to.equal('true')
      expect(flags.map((f) => f.key)).to.deep.equal(['fx-state-archived'])
    })
  })

  describe('fetchSegmentsForEnv', () => {
    it('hits the per-environment segments endpoint', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/segments/default/test`, () =>
          HttpResponse.json({items: [{included: ['u1'], key: 'seg-a'}]}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const segs = await fetchSegmentsForEnv('k', 'default', 'test')
      expect(segs.map((s) => s.key)).to.deep.equal(['seg-a'])
    })
  })

  describe('fetchSnapshot', () => {
    it('stitches environments + context-kinds + flags + per-env segments, de-duping segments by key', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({
            items: [
              {key: 'test', name: 'Test'},
              {key: 'production', name: 'Production'},
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/flags/default`, () =>
          HttpResponse.json({items: [{environments: {}, key: 'f1', kind: 'boolean', variations: []}]}),
        ),
        // Same segment key returned for both envs — must appear once.
        http.get(`${TEST_BASE_URL}/segments/default/test`, () =>
          HttpResponse.json({items: [{key: 'shared-seg'}, {key: 'test-only'}]}),
        ),
        http.get(`${TEST_BASE_URL}/segments/default/production`, () =>
          HttpResponse.json({items: [{key: 'shared-seg'}, {key: 'prod-only'}]}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const snap = await fetchSnapshot('k', 'default')
      expect(snap.environments).to.deep.equal(['test', 'production'])
      expect(snap.contextKinds).to.deep.equal(['user'])
      expect(snap.flags.map((f) => f.key)).to.deep.equal(['f1'])
      expect(snap.segments.map((s) => s.key).sort()).to.deep.equal(['prod-only', 'shared-seg', 'test-only'])
    })
  })
})
