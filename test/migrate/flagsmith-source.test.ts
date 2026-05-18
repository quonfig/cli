import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {__resetSleepForTests, __setSleepForTests, setFlagsmithBaseUrl} from '../../src/migrate/sources/flagsmith/api.js'
import {
  __resetFlagsmithSourceForTests,
  type FlagsmithRaw,
  flagsmithSource,
  getFlagsmithProject,
  getFlagsmithTagPool,
  setFlagsmithProjectId,
} from '../../src/migrate/sources/flagsmith.js'

const TEST_BASE_URL = 'https://flagsmith.test/api/v1'

describe('migrate/sources/flagsmith — MigrationSource wiring', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setFlagsmithBaseUrl(TEST_BASE_URL)
    __setSleepForTests(async () => {})
    __resetFlagsmithSourceForTests()
    setFlagsmithProjectId('38856')
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
  })

  describe('validateAuth', () => {
    it('resolves when /projects/{id}/ returns 200, capturing project metadata', async () => {
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

      await flagsmithSource.validateAuth('good-token')
      const project = getFlagsmithProject()
      expect(project).to.not.equal(null)
      expect(project!.use_edge_identities).to.equal(true)
    })

    it('rejects when /projects/{id}/ returns 401', async () => {
      server = setupServer(http.get(`${TEST_BASE_URL}/projects/38856/`, () => new HttpResponse('no', {status: 401})))
      server.listen({onUnhandledRequest: 'error'})

      try {
        await flagsmithSource.validateAuth('bad-token')
        expect.fail('expected validateAuth to throw')
      } catch (error) {
        expect((error as Error).message).to.match(/401/)
      }
    })
  })

  describe('listEnvironments', () => {
    it('returns slugified env names from the /environments/?project= call', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'}),
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
      )
      server.listen({onUnhandledRequest: 'error'})

      await flagsmithSource.validateAuth('token')
      const envs = await flagsmithSource.listEnvironments()
      expect(envs).to.deep.equal(['development', 'production'])
    })

    it('throws when validateAuth has not been called', async () => {
      // No server needed — fails before any HTTP call.
      try {
        await flagsmithSource.listEnvironments()
        expect.fail('expected throw')
      } catch (error) {
        expect((error as Error).message).to.match(/validateAuth/)
      }
    })
  })

  describe('setFlagsmithProjectId', () => {
    it('routes every API call at the configured project ID instead of the default', async () => {
      setFlagsmithProjectId(99_999)
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/99999/`, () =>
          HttpResponse.json({id: 99_999, name: 'Other', organisation: 1, use_edge_identities: false, uuid: 'u'}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await flagsmithSource.validateAuth('token')
      expect(getFlagsmithProject()?.id).to.equal(99_999)
    })
  })

  describe('fetchChanges', () => {
    function commonStubs() {
      return [
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({
            id: 38_856,
            name: 'Test1',
            organisation: 1,
            only_allow_lower_case_feature_names: true,
            use_edge_identities: false,
            uuid: 'u',
          }),
        ),
        http.get(`${TEST_BASE_URL}/environments/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [{api_key: 'apk1', id: 90, name: 'Development', project: 38_856, uuid: 'u1'}],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/38856/tags/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [
              {color: '#3b82f6', id: 29_679, is_permanent: false, label: 'fx-tag-a', project: 38_856, uuid: 'uA'},
            ],
          }),
        ),
      ]
    }

    it('yields one LegacyChange per feature and per segment, both tagged source=flagsmith', async () => {
      server = setupServer(
        ...commonStubs(),
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
                tags: [29_679],
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

      await flagsmithSource.validateAuth('token')

      const featureChanges: Array<{key?: string; raw: FlagsmithRaw}> = []
      const segmentChanges: Array<{key?: string; raw: FlagsmithRaw}> = []
      for await (const change of flagsmithSource.fetchChanges(null)) {
        expect(change.source).to.equal('flagsmith')
        const raw = change.raw as FlagsmithRaw
        if (raw.kind === 'feature') featureChanges.push({key: change.key, raw})
        else segmentChanges.push({key: change.key, raw})
      }

      expect(featureChanges).to.have.length(1)
      expect(featureChanges[0].key).to.equal('fx-bool')
      expect(featureChanges[0].raw.kind).to.equal('feature')
      const featureBundle = (featureChanges[0].raw as Extract<FlagsmithRaw, {kind: 'feature'}>).data
      expect(featureBundle.feature.name).to.equal('fx-bool')
      expect(featureBundle.featurestates_by_env.apk1.default?.id).to.equal(9000)
      expect(featureBundle.featurestates_by_env.apk1.segment_overrides).to.deep.equal([])

      expect(segmentChanges).to.have.length(1)
      expect(segmentChanges[0].key).to.equal('fx-seg-single-condition')
      expect(segmentChanges[0].raw.kind).to.equal('segment')

      // Tag pool is stashed for Epic 3 to resolve feature.tags[] IDs to labels.
      expect(getFlagsmithTagPool().map((t) => t.label)).to.deep.equal(['fx-tag-a'])
    })

    it('throws when validateAuth has not been called', async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of flagsmithSource.fetchChanges(null)) {
          /* no-op */
        }

        expect.fail('expected throw')
      } catch (error) {
        expect((error as Error).message).to.match(/validateAuth/)
      }
    })
  })

  describe('translate', () => {
    it('returns a Quonfig segment file when called with a segment LegacyChange (Epic 3)', () => {
      const out = flagsmithSource.translate({
        key: 'seg-x',
        raw: {
          data: {
            description: null,
            id: 1,
            name: 'seg-x',
            project: 38_856,
            rules: [{conditions: [{operator: 'EQUAL', property: 'plan', value: 'enterprise'}], rules: [], type: 'ALL'}],
            uuid: 'u',
          },
          kind: 'segment',
        },
        source: 'flagsmith',
      })
      expect(out).to.have.length(1)
      expect(out[0].path).to.equal('segments/seg-x.json')
      const parsed = JSON.parse(out[0].contents ?? '{}') as {type: string; valueType: string}
      expect(parsed.type).to.equal('segment')
      expect(parsed.valueType).to.equal('bool')
    })

    it('returns an empty array when raw is not a recognized FlagsmithRaw shape', () => {
      const out = flagsmithSource.translate({key: 'x', raw: {unknown: true}, source: 'flagsmith'})
      expect(out).to.deep.equal([])
    })
  })

  describe('getEnvironmentMap', () => {
    it('returns null before any fetch', () => {
      expect(flagsmithSource.getEnvironmentMap?.()).to.equal(null)
    })

    it('returns source-name → slugified-name pairs after listEnvironments', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/38856/`, () =>
          HttpResponse.json({id: 38_856, name: 'Test1', organisation: 1, use_edge_identities: false, uuid: 'u'}),
        ),
        http.get(`${TEST_BASE_URL}/environments/`, () =>
          HttpResponse.json({
            count: 1,
            next: null,
            previous: null,
            results: [{api_key: 'apk1', id: 90, name: 'Production', project: 38_856, uuid: 'u'}],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await flagsmithSource.validateAuth('token')
      await flagsmithSource.listEnvironments()
      const entries = flagsmithSource.getEnvironmentMap?.()
      expect(entries).to.deep.equal([{quonfigName: 'production', sourceName: 'Production'}])
    })
  })
})
