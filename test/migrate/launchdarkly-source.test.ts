import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {
  __resetSleepForTests,
  __setSleepForTests,
  setLaunchDarklyBaseUrl,
} from '../../src/migrate/sources/launchdarkly/api.js'
import {
  __resetLaunchDarklySourceForTests,
  getLaunchDarklyRetentionHorizon,
  launchdarklySource,
  setLaunchDarklyFullSummary,
  setLaunchDarklyProjectKey,
} from '../../src/migrate/sources/launchdarkly.js'
import type {LegacyChange} from '../../src/migrate/source.js'
import {validateFileMap} from '../../src/verify/validate.js'

const TEST_BASE_URL = 'https://ld.test/api/v2'

describe('migrate/sources/launchdarkly — MigrationSource wiring', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setLaunchDarklyBaseUrl(TEST_BASE_URL)
    __setSleepForTests(async () => {})
    __resetLaunchDarklySourceForTests()
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
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

  describe('setLaunchDarklyProjectKey', () => {
    it('routes every API call at the configured project key instead of "default"', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/acme-mobile/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
      )
      // onUnhandledRequest:'error' means a stray /projects/default/... call fails the test.
      server.listen({onUnhandledRequest: 'error'})

      setLaunchDarklyProjectKey('acme-mobile')
      await launchdarklySource.validateAuth('token')
    })
  })

  describe('fetchChanges + translate', () => {
    it('yields a LegacyChange per flag and per segment, and translates them to QuonfigFile[]', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/members`, () => HttpResponse.json({items: []})),
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
        http.get(`${TEST_BASE_URL}/members`, () => HttpResponse.json({items: []})),
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

  describe('--full-summary (Phase 2 audit-log history)', () => {
    function flagVersion(key: string, on: boolean) {
      return {
        environments: {production: {fallthrough: {variation: on ? 0 : 1}, on}},
        key,
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }
    }

    it('getCommitMeta reifies the original LD member, date and description from an audit change', () => {
      const change: LegacyChange = {
        changedAt: 4444,
        key: 'flag-x',
        raw: {
          auditEntry: {
            _id: 'a1',
            currentVersion: flagVersion('flag-x', true),
            date: 4444,
            member: {email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace'},
            shortDescription: 'turned flag-x on',
          },
          data: flagVersion('flag-x', true),
          kind: 'flag',
        },
        source: 'launchdarkly',
      }

      const meta = launchdarklySource.getCommitMeta!(change)
      expect(meta).to.not.equal(null)
      expect(meta!.author).to.deep.equal({email: 'ada@example.com', name: 'Ada Lovelace'})
      expect(meta!.date).to.equal(4444)
      expect(meta!.message).to.equal('turned flag-x on')
    })

    it('getCommitMeta returns null for a current-state change with no audit entry (→ migrator identity)', () => {
      const change: LegacyChange = {
        key: 'flag-x',
        raw: {data: flagVersion('flag-x', true), kind: 'flag'},
        source: 'launchdarkly',
      }
      expect(launchdarklySource.getCommitMeta!(change)).to.equal(null)
    })

    it('fetchChanges walks the audit log and yields flag changes oldest-first when full-summary is set', async () => {
      server = setupServer(
        // Audit listing — LD returns newest-first.
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          const before = new URL(request.url).searchParams.get('before')
          if (before) return HttpResponse.json({items: []})
          return HttpResponse.json({
            items: [
              {_id: 'a2', date: 2000},
              {_id: 'a1', date: 1000},
            ],
          })
        }),
        http.get(`${TEST_BASE_URL}/auditlog/:id`, ({params}) => {
          const id = params.id as string
          const date = id === 'a1' ? 1000 : 2000
          return HttpResponse.json({
            _id: id,
            currentVersion: flagVersion('flag-x', id === 'a2'),
            date,
            member: {email: 'ada@example.com', firstName: 'Ada'},
            shortDescription: `change ${id}`,
          })
        }),
        http.get(`${TEST_BASE_URL}/members`, () => HttpResponse.json({items: []})),
        // Current-state segments are still re-snapshotted so --full-summary
        // doesn't silently drop them (the audit log is flag-scoped).
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
        ),
        http.get(`${TEST_BASE_URL}/segments/default/production`, () => HttpResponse.json({items: []})),
      )
      server.listen({onUnhandledRequest: 'error'})

      setLaunchDarklyFullSummary(true)
      await launchdarklySource.validateAuth('token')

      const changes: LegacyChange[] = []
      for await (const change of launchdarklySource.fetchChanges(null)) {
        changes.push(change)
      }

      // Audit log is newest-first; fetchChanges must reverse it so the write
      // paths commit changes in chronological order.
      expect(changes.map((c) => c.changedAt)).to.deep.equal([1000, 2000])
      expect(changes[0].source).to.equal('launchdarkly')
      const meta0 = launchdarklySource.getCommitMeta!(changes[0])
      expect(meta0!.message).to.equal('change a1')
    })

    it('validateAuth runs the retention pre-flight under full-summary and exposes the horizon', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
        ),
        // Every retention probe comes back empty — nothing older than 30 days.
        http.get(`${TEST_BASE_URL}/auditlog`, () => HttpResponse.json({items: []})),
      )
      server.listen({onUnhandledRequest: 'error'})

      setLaunchDarklyFullSummary(true)
      await launchdarklySource.validateAuth('token')

      const horizon = getLaunchDarklyRetentionHorizon()
      expect(horizon).to.not.equal(null)
      expect(horizon!.developerPlanLikely).to.equal(true)
    })

    it('does not probe retention or touch the audit log when full-summary is off', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
        ),
      )
      // onUnhandledRequest:'error' — a stray /auditlog call would fail the test.
      server.listen({onUnhandledRequest: 'error'})

      await launchdarklySource.validateAuth('token')
      expect(getLaunchDarklyRetentionHorizon()).to.equal(null)
    })
  })

  describe('getMaintainerMap (qfg-l8uz)', () => {
    it('returns id → email pairs from /members after fetchChanges runs', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/members`, () =>
          HttpResponse.json({
            items: [
              {_id: '6a01c58d51b2060a7e9178e1', email: 'ada@acme.test'},
              {_id: '7b02d691f1c12abc1234efef', email: 'bob@acme.test'},
              // Members with no email are skipped (nothing useful to render).
              {_id: '8c03e7a0aaaabbbbccccdddd'},
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/flags/default`, () => HttpResponse.json({items: []})),
        http.get(`${TEST_BASE_URL}/segments/default/test`, () => HttpResponse.json({items: []})),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchdarklySource.validateAuth('token')
      // Drain — the map is loaded as a side-effect of the snapshot fetch.
      const drained: LegacyChange[] = []
      for await (const change of launchdarklySource.fetchChanges(null)) {
        drained.push(change)
      }

      expect(drained).to.be.an('array')
      const map = launchdarklySource.getMaintainerMap!()
      expect(map).to.deep.equal({
        '6a01c58d51b2060a7e9178e1': 'ada@acme.test',
        '7b02d691f1c12abc1234efef': 'bob@acme.test',
      })
    })

    it('returns null when /members is forbidden — migration still runs', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/members`, () => new HttpResponse('forbidden', {status: 403})),
        http.get(`${TEST_BASE_URL}/flags/default`, () => HttpResponse.json({items: []})),
        http.get(`${TEST_BASE_URL}/segments/default/test`, () => HttpResponse.json({items: []})),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchdarklySource.validateAuth('token')
      // Drain — no flags, but the loader still runs.
      const drained: LegacyChange[] = []
      for await (const change of launchdarklySource.fetchChanges(null)) {
        drained.push(change)
      }

      expect(drained).to.have.length(0)
      expect(launchdarklySource.getMaintainerMap!()).to.equal(null)
    })
  })
})
