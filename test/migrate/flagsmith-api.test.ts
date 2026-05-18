import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {
  FlagsmithApiError,
  __resetSleepForTests,
  __setSleepForTests,
  fetchEdgeIdentities,
  fetchEdgeIdentityOverrides,
  fetchEnvFeatureStates,
  fetchEnvironments,
  fetchFeatureSegments,
  fetchFeatures,
  fetchProject,
  fetchSegments,
  fetchSnapshot,
  fetchTags,
  setFlagsmithBaseUrl,
} from '../../src/migrate/sources/flagsmith/api.js'

const TEST_BASE_URL = 'https://flagsmith.test/api/v1'

describe('migrate/sources/flagsmith/api', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setFlagsmithBaseUrl(TEST_BASE_URL)
    __setSleepForTests(async () => {})
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
  })

  describe('auth header', () => {
    it('sends `Api-Key <token>` in Authorization', async () => {
      let capturedAuth = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, ({request}) => {
          capturedAuth = request.headers.get('Authorization') ?? ''
          return HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: true, uuid: 'u'})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchProject('SECRET.token', '38856')
      expect(capturedAuth).to.equal('Api-Key SECRET.token')
    })
  })

  describe('fetchProject', () => {
    it('returns the project record', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({
            id: 38_856,
            name: 'Test1',
            organisation: 1,
            only_allow_lower_case_feature_names: true,
            use_edge_identities: true,
            use_v2_feature_versioning: true,
            uuid: 'u',
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const project = await fetchProject('k', '38856')
      expect(project.id).to.equal(38_856)
      expect(project.use_edge_identities).to.equal(true)
    })

    it('throws FlagsmithApiError on 401', async () => {
      server = setupServer(http.get(`${TEST_BASE_URL}/projects/38856/`, () => new HttpResponse('nope', {status: 401})))
      server.listen({onUnhandledRequest: 'error'})

      try {
        await fetchProject('bad', '38856')
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(FlagsmithApiError)
        expect((error as FlagsmithApiError).status).to.equal(401)
      }
    })
  })

  describe('fetchEnvironments', () => {
    it('returns the env list and follows the absolute `next` URL across pages', async () => {
      const seen: string[] = []
      server = setupServer(
        http.get(`${TEST_BASE_URL}/environments/`, ({request}) => {
          const u = new URL(request.url)
          seen.push(u.search)
          if (u.searchParams.get('page') === '2') {
            return HttpResponse.json({
              count: 2,
              next: null,
              previous: null,
              results: [{api_key: 'apk2', id: 91, name: 'Production', project: 38_856, uuid: 'u2'}],
            })
          }

          return HttpResponse.json({
            count: 2,
            // Absolute prod URL — fetcher must rewrite it to hit our test base URL.
            next: 'https://api.flagsmith.com/api/v1/environments/?project=38856&page=2&page_size=100',
            previous: null,
            results: [{api_key: 'apk1', id: 90, name: 'Development', project: 38_856, uuid: 'u1'}],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const envs = await fetchEnvironments('k', '38856')
      expect(envs.map((e) => e.name)).to.deep.equal(['Development', 'Production'])
      // First call carries ?project=...; second carries ?page=2 too.
      expect(seen.some((s) => s.includes('page=2'))).to.equal(true)
    })
  })

  describe('429 backoff honors Retry-After', () => {
    it('retries after a 429 and succeeds', async () => {
      let calls = 0
      const waited: number[] = []
      __setSleepForTests(async (ms) => {
        waited.push(ms)
      })
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () => {
          calls++
          if (calls === 1) {
            return new HttpResponse('rate limited', {
              headers: {'Retry-After': '3'},
              status: 429,
            })
          }

          return HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const project = await fetchProject('k', '38856')
      expect(calls).to.equal(2)
      expect(project.id).to.equal(38_856)
      // 3 seconds from the Retry-After header — must be >= 3000ms.
      expect(waited[0]).to.be.greaterThanOrEqual(3000)
    })

    it('honors X-RateLimit-Reset as seconds-from-now when no Retry-After', async () => {
      let calls = 0
      const waited: number[] = []
      __setSleepForTests(async (ms) => {
        waited.push(ms)
      })
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () => {
          calls++
          if (calls === 1) {
            return new HttpResponse('rate limited', {
              headers: {'X-RateLimit-Reset': '5'},
              status: 429,
            })
          }

          return HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchProject('k', '38856')
      expect(calls).to.equal(2)
      // 5 seconds from X-RateLimit-Reset — must be >= 5000ms.
      expect(waited[0]).to.be.greaterThanOrEqual(5000)
    })
  })

  describe('fetchFeatures', () => {
    it('sorts inline multivariate_options ASC by id (API6 — API returns reverse creation order)', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/features/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                default_enabled: true,
                id: 1,
                is_archived: false,
                multivariate_options: [
                  // API returns reverse creation order; fetcher must un-reverse.
                  {
                    boolean_value: null,
                    default_percentage_allocation: 33.34,
                    id: 27_414,
                    integer_value: null,
                    string_value: 'b',
                    type: 'unicode',
                    uuid: 'uB',
                  },
                  {
                    boolean_value: null,
                    default_percentage_allocation: 33.33,
                    id: 27_413,
                    integer_value: null,
                    string_value: 'a',
                    type: 'unicode',
                    uuid: 'uA',
                  },
                  {
                    boolean_value: null,
                    default_percentage_allocation: 33.33,
                    id: 27_412,
                    integer_value: null,
                    string_value: 'control',
                    type: 'unicode',
                    uuid: 'uC',
                  },
                ],
                name: 'fx-mv-string-3way',
                project: 38_856,
                tags: [],
                type: 'MULTIVARIATE',
                uuid: 'uF',
              },
            ],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const features = await fetchFeatures('k', '38856')
      expect(features[0].multivariate_options.map((m) => m.id)).to.deep.equal([27_412, 27_413, 27_414])
      // ASC by id ⇒ definition order (control, a, b).
      expect(features[0].multivariate_options.map((m) => m.string_value)).to.deep.equal(['control', 'a', 'b'])
    })
  })

  describe('fetchEnvFeatureStates', () => {
    it('returns both env-default and segment-override rows from /features/featurestates/', async () => {
      let capturedQs = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/features/featurestates/`, ({request}) => {
          capturedQs = new URL(request.url).search
          return HttpResponse.json({
            count: 2,
            next: null,
            previous: null,
            results: [
              {
                enabled: false,
                environment: 90,
                feature: 207_700,
                feature_segment: null,
                feature_state_value: {
                  boolean_value: null,
                  integer_value: null,
                  string_value: 'default',
                  type: 'unicode',
                },
                id: 1_414_682,
                multivariate_feature_state_values: [],
                uuid: 'us1',
              },
              {
                enabled: true,
                environment: 90,
                feature: 207_700,
                feature_segment: {id: 248_855, priority: 0, segment: 1_127_682, uuid: 'fseg'},
                feature_state_value: {
                  boolean_value: null,
                  integer_value: null,
                  string_value: 'seg-value',
                  type: 'unicode',
                },
                id: 1_414_683,
                multivariate_feature_state_values: [],
                uuid: 'us2',
              },
            ],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const rows = await fetchEnvFeatureStates('k', 90)
      expect(rows).to.have.length(2)
      expect(rows[0].feature_segment).to.equal(null)
      expect(rows[1].feature_segment).to.deep.include({id: 248_855, priority: 0})
      expect(capturedQs).to.include('environment=90')
    })
  })

  describe('fetchSegments', () => {
    it('returns project-scoped segments', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/segments/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                id: 1_127_682,
                name: 'fx-seg-single-condition',
                project: 38_856,
                rules: [
                  {conditions: [{operator: 'EQUAL', property: 'plan', value: 'enterprise'}], rules: [], type: 'ALL'},
                ],
                uuid: 'us',
              },
            ],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const segs = await fetchSegments('k', '38856')
      expect(segs.map((s) => s.name)).to.deep.equal(['fx-seg-single-condition'])
    })
  })

  describe('fetchFeatureSegments', () => {
    it('requires environment + feature in the query string', async () => {
      let capturedQs = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/features/feature-segments/`, ({request}) => {
          capturedQs = new URL(request.url).search
          return HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [{environment: 90, id: 248_855, priority: 0, segment: 1_127_682, segment_name: 'seg', uuid: 'us'}],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchFeatureSegments('k', 90, 207_700)
      expect(capturedQs).to.include('environment=90')
      expect(capturedQs).to.include('feature=207700')
    })
  })

  describe('fetchEdgeIdentities', () => {
    it('paginates via last_evaluated_key', async () => {
      let calls = 0
      server = setupServer(
        http.get(`${TEST_BASE_URL}/environments/apk1/edge-identities/`, ({request}) => {
          calls++
          const cursor = new URL(request.url).searchParams.get('last_evaluated_key')
          if (cursor) {
            return HttpResponse.json({
              last_evaluated_key: null,
              results: [{dashboard_alias: null, identifier: 'id-b', identity_uuid: 'uB'}],
            })
          }

          return HttpResponse.json({
            last_evaluated_key: 'abc',
            results: [{dashboard_alias: null, identifier: 'id-a', identity_uuid: 'uA'}],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const ids = await fetchEdgeIdentities('k', 'apk1')
      expect(calls).to.equal(2)
      expect(ids.map((i) => i.identifier)).to.deep.equal(['id-a', 'id-b'])
    })
  })

  describe('fetchEdgeIdentityOverrides', () => {
    it('returns the {results} list (no trailing slash on path)', async () => {
      let path = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/environments/apk1/edge-identity-overrides`, ({request}) => {
          path = new URL(request.url).pathname
          return HttpResponse.json({
            results: [
              {
                feature_state: {
                  enabled: true,
                  feature: 207_712,
                  feature_state_value: 'id-override',
                  featurestate_uuid: 'ufs',
                  multivariate_feature_state_values: [],
                },
                identifier: 'fx-id-string',
                identity_uuid: '39978094',
              },
            ],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const ovs = await fetchEdgeIdentityOverrides('k', 'apk1')
      expect(ovs).to.have.length(1)
      expect(ovs[0].feature_state.feature_state_value).to.equal('id-override')
      // Confirm we are NOT calling the trailing-slash variant.
      expect(path).to.equal('/api/v1/environments/apk1/edge-identity-overrides')
    })
  })

  describe('fetchTags', () => {
    it('returns the project tag pool', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/tags/`, () =>
          HttpResponse.json({
            count: 2,
            next: null,
            previous: null,
            results: [
              {color: '#3b82f6', id: 29_679, is_permanent: false, label: 'fx-tag-a', project: 38_856, uuid: 'uA'},
              {color: '#10b981', id: 29_680, is_permanent: false, label: 'fx-tag-b', project: 38_856, uuid: 'uB'},
            ],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const tags = await fetchTags('k', '38856')
      expect(tags.map((t) => t.label)).to.deep.equal(['fx-tag-a', 'fx-tag-b'])
    })
  })

  describe('fetchSnapshot', () => {
    it('stitches project + envs + features + featurestates + segments + tags into FlagsmithSnapshot', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'}),
        ),
        http.get(`${TEST_BASE_URL}/environments/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [{api_key: 'apk1', id: 90, name: 'Development', project: 38_856, uuid: 'u1'}],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/features/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                default_enabled: true,
                id: 200,
                is_archived: false,
                multivariate_options: [],
                name: 'fx-bool',
                project: 38_856,
                tags: [],
                type: 'STANDARD',
                uuid: 'uF',
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/features/featurestates/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                enabled: true,
                environment: 90,
                feature: 200,
                feature_segment: null,
                feature_state_value: {boolean_value: null, integer_value: null, string_value: null, type: 'unicode'},
                id: 9000,
                multivariate_feature_state_values: [],
                uuid: 'us',
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/segments/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/tags/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const snap = await fetchSnapshot('k', '38856')
      expect(snap.project.id).to.equal(38_856)
      expect(snap.environments.map((e) => e.api_key)).to.deep.equal(['apk1'])
      expect(snap.features).to.have.length(1)
      expect(snap.features[0].featurestates_by_env.apk1.default?.id).to.equal(9000)
      expect(snap.features[0].featurestates_by_env.apk1.segment_overrides).to.deep.equal([])
      expect(snap.features[0].featurestates_by_env.apk1.identity_overrides).to.deep.equal([])
    })

    it('orders segment overrides by feature-segment priority (ASC)', async () => {
      // Two segov featurestates with feature_segment as numeric IDs (legacy
      // shape) — the stitcher must resolve priorities via
      // /features/feature-segments/?environment=&feature=.
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'}),
        ),
        http.get(`${TEST_BASE_URL}/environments/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [{api_key: 'apk1', id: 90, name: 'Development', project: 38_856, uuid: 'u1'}],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/features/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                default_enabled: true,
                id: 200,
                is_archived: false,
                multivariate_options: [],
                name: 'fx-multi-segov',
                project: 38_856,
                tags: [],
                type: 'STANDARD',
                uuid: 'uF',
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/features/featurestates/`, () =>
          HttpResponse.json({
            count: 3,
            next: null,
            previous: null,
            results: [
              {
                enabled: true,
                environment: 90,
                feature: 200,
                feature_segment: null,
                feature_state_value: 'default',
                id: 1,
                multivariate_feature_state_values: [],
                uuid: 'u1',
              },
              // Numeric feature_segment IDs (priorities resolved via feature-segments lookup).
              {
                enabled: true,
                environment: 90,
                feature: 200,
                feature_segment: 901,
                feature_state_value: 'priority-1',
                id: 2,
                multivariate_feature_state_values: [],
                uuid: 'u2',
              },
              {
                enabled: true,
                environment: 90,
                feature: 200,
                feature_segment: 900,
                feature_state_value: 'priority-0',
                id: 3,
                multivariate_feature_state_values: [],
                uuid: 'u3',
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/features/feature-segments/`, () =>
          HttpResponse.json({
            count: 2,
            next: null,
            previous: null,
            results: [
              {environment: 90, id: 900, priority: 0, segment: 5000, uuid: 'u'},
              {environment: 90, id: 901, priority: 1, segment: 5001, uuid: 'u'},
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/segments/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/tags/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      const snap = await fetchSnapshot('k', '38856')
      const bundle = snap.features[0].featurestates_by_env.apk1
      expect(bundle.default?.feature_state_value).to.equal('default')
      // Sorted by priority ASC (0 before 1) — so 'priority-0' first, 'priority-1' second.
      expect(bundle.segment_overrides.map((s) => s.feature_state_value)).to.deep.equal(['priority-0', 'priority-1'])
    })

    it('walks /edge-identity-overrides only when project.use_edge_identities is true', async () => {
      let edgeCalled = false
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'}),
        ),
        http.get(`${TEST_BASE_URL}/environments/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [{api_key: 'apk1', id: 90, name: 'Development', project: 38_856, uuid: 'u1'}],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/features/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/features/featurestates/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/segments/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/tags/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/environments/apk1/edge-identity-overrides`, () => {
          edgeCalled = true
          return HttpResponse.json({results: []})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      await fetchSnapshot('k', '38856')
      expect(edgeCalled).to.equal(false)
    })

    it('walks /edge-identity-overrides per env when use_edge_identities is true and indexes by feature', async () => {
      const edgeCalls: string[] = []
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: true, uuid: 'u'}),
        ),
        http.get(`${TEST_BASE_URL}/environments/`, () =>
          HttpResponse.json({
            count: 2,
            next: null,
            previous: null,
            results: [
              {api_key: 'apk1', id: 90, name: 'Development', project: 38_856, uuid: 'u1'},
              {api_key: 'apk2', id: 91, name: 'Production', project: 38_856, uuid: 'u2'},
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/features/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                default_enabled: true,
                id: 207_712,
                is_archived: false,
                multivariate_options: [],
                name: 'fx-idov-single',
                project: 38_856,
                tags: [],
                type: 'STANDARD',
                uuid: 'uF',
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/features/featurestates/`, ({request}) => {
          const envId = new URL(request.url).searchParams.get('environment')
          return HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                enabled: true,
                environment: Number(envId),
                feature: 207_712,
                feature_segment: null,
                feature_state_value: 'default',
                id: 100 + Number(envId),
                multivariate_feature_state_values: [],
                uuid: 'u',
              },
            ],
          })
        }),
        http.get(`${TEST_BASE_URL}/projects/38856/segments/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/tags/`, () =>
          HttpResponse.json({count: 0, next: null, previous: null, results: []}),
        ),
        http.get(`${TEST_BASE_URL}/environments/:apk/edge-identity-overrides`, ({params}) => {
          const envApiKey = params.apk as string
          edgeCalls.push(envApiKey)
          // API8: each env returns a DIFFERENT identity_uuid for the same identifier.
          const identity_uuid = envApiKey === 'apk1' ? 'uuid-dev' : 'uuid-prod'
          return HttpResponse.json({
            results: [
              {
                feature_state: {
                  enabled: true,
                  feature: 207_712,
                  feature_state_value: envApiKey === 'apk1' ? 'dev-override' : 'prod-override',
                  multivariate_feature_state_values: [],
                },
                identifier: 'fx-id-string',
                identity_uuid,
              },
            ],
          })
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const snap = await fetchSnapshot('k', '38856')
      // Walked one /edge-identity-overrides call per env.
      expect(edgeCalls.sort()).to.deep.equal(['apk1', 'apk2'])
      // Identity overrides bundled under the right env keys.
      const apk1 = snap.features[0].featurestates_by_env.apk1
      const apk2 = snap.features[0].featurestates_by_env.apk2
      expect(apk1.identity_overrides).to.have.length(1)
      expect(apk1.identity_overrides[0].feature_state.feature_state_value).to.equal('dev-override')
      expect(apk1.identity_overrides[0].identity_uuid).to.equal('uuid-dev')
      expect(apk2.identity_overrides[0].identity_uuid).to.equal('uuid-prod')
    })
  })
})
