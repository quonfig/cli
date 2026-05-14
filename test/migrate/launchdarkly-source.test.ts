import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {setLaunchDarklyBaseUrl} from '../../src/migrate/sources/launchdarkly/api.js'
import {__resetLaunchDarklySourceForTests, launchdarklySource} from '../../src/migrate/sources/launchdarkly.js'
import {validateFileMap} from '../../src/verify/validate.js'

const TEST_BASE_URL = 'https://ld.test/api/v2'

describe('migrate/sources/launchdarkly — MigrationSource wiring', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setLaunchDarklyBaseUrl(TEST_BASE_URL)
    __resetLaunchDarklySourceForTests()
  })

  afterEach(() => {
    if (server) server.close()
  })

  describe('validateAuth', () => {
    it('resolves when the environments probe returns 200', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})
      await launchdarklySource.validateAuth('good-token')
    })

    it('rejects when the environments probe returns 401', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () => new HttpResponse('no', {status: 401})),
      )
      server.listen({onUnhandledRequest: 'error'})
      try {
        await launchdarklySource.validateAuth('bad-token')
        expect.fail('expected validateAuth to throw')
      } catch (error) {
        expect((error as Error).message).to.match(/401/)
      }
    })
  })

  describe('fetchChanges + translate', () => {
    it('yields a LegacyChange per flag and per segment, and translates them to QuonfigFile[]', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/flags/default`, () =>
          HttpResponse.json({
            items: [
              {
                environments: {test: {fallthrough: {variation: 0}, on: true}},
                key: 'my-flag',
                kind: 'boolean',
                variations: [{value: true}, {value: false}],
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/segments/default/test`, () =>
          HttpResponse.json({items: [{included: ['vip'], key: 'my-seg'}]}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchdarklySource.validateAuth('token')

      const files: Array<{contents?: string; path: string}> = []
      for await (const change of launchdarklySource.fetchChanges(null)) {
        expect(change.source).to.equal('launchdarkly')
        files.push(...launchdarklySource.translate(change))
      }

      const paths = files.map((f) => f.path).sort()
      expect(paths).to.deep.equal(['feature-flags/my-flag.json', 'segments/my-seg.json'])

      const flagFile = files.find((f) => f.path === 'feature-flags/my-flag.json')!
      const parsed = JSON.parse(flagFile.contents!)
      expect(parsed.key).to.equal('my-flag')
      expect(parsed.type).to.equal('feature_flag')
      expect(parsed.environments[0].id).to.equal('test')
    })
  })

  describe('getSkippedConfigs', () => {
    it('surfaces a flag whose conversion threw as a skipped config, and keeps the run going', () => {
      // A flag whose `environments` is not an object makes translateFlag throw;
      // the source must record it and return [] rather than aborting.
      const files = launchdarklySource.translate({
        key: 'broken-flag',
        raw: {data: {environments: null, key: 'broken-flag', kind: 'boolean', variations: []}, kind: 'flag'},
        source: 'launchdarkly',
      } as never)
      expect(files).to.deep.equal([])

      const skipped = launchdarklySource.getSkippedConfigs?.()
      expect(skipped).to.not.equal(null)
      expect(skipped!.total).to.equal(1)
      expect(skipped!.entries[0].key).to.equal('broken-flag')
    })
  })

  describe('converter output is schema-valid (round-trip through qfg verify)', () => {
    it('a multi-env flag with rules, a rollout, and targets — plus a segment — pass validateFileMap with no errors', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({
            items: [
              {key: 'production', name: 'Production'},
              {key: 'test', name: 'Test'},
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/flags/default`, () =>
          HttpResponse.json({
            items: [
              {
                description: 'A representative flag',
                environments: {
                  production: {
                    fallthrough: {
                      rollout: {
                        variations: [
                          {variation: 0, weight: 70_000},
                          {variation: 1, weight: 30_000},
                        ],
                      },
                    },
                    on: true,
                    rules: [{clauses: [{attribute: 'email', op: 'endsWith', values: ['@acme.com']}], variation: 1}],
                    targets: [{values: ['vip-1', 'vip-2'], variation: 1}],
                  },
                  test: {offVariation: 0, on: false},
                },
                key: 'representative-flag',
                kind: 'multivariate',
                tags: ['migrated', 'launchdarkly'],
                variations: [
                  {name: 'control', value: 'control'},
                  {name: 'treatment', value: 'treatment'},
                ],
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/segments/default/production`, () =>
          HttpResponse.json({
            items: [
              {
                excluded: ['banned'],
                included: ['allowlisted'],
                key: 'rep-segment',
                rules: [{clauses: [{attribute: 'plan', op: 'in', values: ['enterprise']}]}],
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/segments/default/test`, () => HttpResponse.json({items: []})),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchdarklySource.validateAuth('token')

      const fileMap = new Map<string, string>()
      fileMap.set('quonfig.json', JSON.stringify({environments: ['production', 'test']}))
      for await (const change of launchdarklySource.fetchChanges(null)) {
        for (const file of launchdarklySource.translate(change)) {
          if (file.contents !== undefined) fileMap.set(file.path, file.contents)
        }
      }

      const result = validateFileMap(fileMap)
      const errors = result.issues.filter((i) => i.severity === 'error')
      expect(errors, JSON.stringify(errors, null, 2)).to.deep.equal([])
    })
  })
})
