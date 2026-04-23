import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {launchSource} from '../../src/migrate/sources/launch.js'
import {setLaunchBaseUrl} from '../../src/migrate/sources/launch/api.js'

const TEST_BASE_URL = 'https://api.launch.test'
const USER = {email: 'a@b', id: 'u1', type: 'user'}

describe('migrate/sources/launch — MigrationSource wiring', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setLaunchBaseUrl(TEST_BASE_URL)
  })

  afterEach(() => {
    if (server) server.close()
  })

  describe('validateAuth', () => {
    it('resolves when /api/v1/project-environments returns 200', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('good-key')
    })

    it('rejects when /api/v1/project-environments returns 401', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () => new HttpResponse('unauthorized', {status: 401})),
      )
      server.listen({onUnhandledRequest: 'error'})

      try {
        await launchSource.validateAuth('bad-key')
        expect.fail('expected validateAuth to throw on 401')
      } catch (error) {
        expect((error as Error).message).to.match(/401/)
      }
    })
  })

  describe('listEnvironments', () => {
    it('returns slugified env names after validateAuth', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({
            envs: [
              {id: 1, name: 'Production'},
              {id: 2, name: 'Staging Area'},
            ],
            projectId: 1,
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      const envs = await launchSource.listEnvironments()
      expect(envs).to.include.members(['production', 'staging-area'])
    })
  })

  describe('fetchChanges', () => {
    it('yields changes oldest→newest and stops at sinceEpochMs', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () =>
          HttpResponse.json({
            changes: [
              {changedAt: 300, changedBy: USER, deleted: false, key: 'new', newConfigId: 3, type: 'FEATURE_FLAG'},
              {changedAt: 100, changedBy: USER, deleted: false, key: 'old', newConfigId: 1, type: 'FEATURE_FLAG'},
            ],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      const emitted: number[] = []
      for await (const change of launchSource.fetchChanges(100)) {
        if (typeof change.changedAt === 'number') emitted.push(change.changedAt)
      }

      expect(emitted).to.deep.equal([300])
    })

    it('yields all changes when sinceEpochMs is null', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
        http.get(`${TEST_BASE_URL}/api/v1/change-history`, () =>
          HttpResponse.json({
            changes: [
              {changedAt: 300, changedBy: USER, deleted: false, key: 'new', newConfigId: 3, type: 'FEATURE_FLAG'},
              {changedAt: 100, changedBy: USER, deleted: false, key: 'old', newConfigId: 1, type: 'FEATURE_FLAG'},
            ],
          }),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      const emitted: number[] = []
      for await (const change of launchSource.fetchChanges(null)) {
        if (typeof change.changedAt === 'number') emitted.push(change.changedAt)
      }

      expect(emitted).to.deep.equal([100, 300])
    })
  })

  describe('translate', () => {
    it('returns QuonfigFile[] with path under feature-flags/ for a FEATURE_FLAG change', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      await launchSource.listEnvironments()

      const raw = {
        changedAt: 1,
        changedBy: USER,
        deleted: false,
        key: 'my-flag',
        newConfig: {
          environments: [{id: '1', rules: []}],
          id: '1',
          key: 'my-flag',
          projectId: 'p',
          type: 'feature_flag',
          valueType: 'bool',
        },
        newConfigId: 3,
        type: 'FEATURE_FLAG',
      }

      const files = launchSource.translate({key: 'my-flag', raw, source: 'launch'})
      expect(files).to.have.length(1)
      expect(files[0].path).to.equal('feature-flags/my-flag.json')
      expect(files[0].contents).to.be.a('string')
      const parsed = JSON.parse(files[0].contents!)
      expect(parsed.key).to.equal('my-flag')
      const environments = parsed.environments as Array<{id: string}>
      expect(environments[0].id).to.equal('prod')
    })

    it('returns an empty array for a legacy LOG_LEVEL change (skipped upstream)', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      await launchSource.listEnvironments()

      const files = launchSource.translate({
        key: 'old',
        raw: {changedAt: 1, changedBy: USER, deleted: false, key: 'old', newConfigId: 1, type: 'LOG_LEVEL'},
        source: 'launch',
      })
      expect(files).to.deep.equal([])
    })

    it('emits a deleted file op for a tombstone (qfg-zfl.18)', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      await launchSource.listEnvironments()

      const files = launchSource.translate({
        key: 'gone',
        raw: {changedAt: 1, changedBy: USER, deleted: true, key: 'gone', newConfigId: 1, type: 'FEATURE_FLAG'},
        source: 'launch',
      })
      expect(files).to.have.length(1)
      expect(files[0]).to.deep.equal({deleted: true, path: 'feature-flags/gone.json'})
    })

    it('emits a deleted file op for a CONFIG tombstone with correct path (qfg-zfl.18)', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      await launchSource.listEnvironments()

      const files = launchSource.translate({
        key: 'gone-config',
        raw: {changedAt: 1, changedBy: USER, deleted: true, key: 'gone-config', newConfigId: 1, type: 'CONFIG'},
        source: 'launch',
      })
      expect(files).to.deep.equal([{deleted: true, path: 'configs/gone-config.json'}])
    })

    it('skips an invalid variant/valueType config with a warning and returns [] (qfg-zfl.19)', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'prod'}], projectId: 1}),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      await launchSource.validateAuth('key')
      await launchSource.listEnvironments()

      const files = launchSource.translate({
        key: 'bad-variants',
        raw: {
          changedAt: 1,
          changedBy: USER,
          deleted: false,
          key: 'bad-variants',
          newConfig: {
            default: {
              rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: '44'}}],
            },
            environments: [],
            id: '1',
            key: 'bad-variants',
            projectId: 'p',
            type: 'config',
            valueType: 'double',
            variants: [
              {value: {type: 'string', value: '44'}},
              {value: {type: 'double', value: '23.0'}},
            ],
          },
          newConfigId: 1,
          type: 'CONFIG',
        },
        source: 'launch',
      })
      expect(files).to.deep.equal([])

      const skipped = launchSource.getSkippedConfigs?.()
      expect(skipped).to.not.equal(null)
      expect(skipped!.total).to.equal(1)
      expect(skipped!.entries).to.have.length(1)
      expect(skipped!.entries[0].key).to.equal('bad-variants')
      expect(skipped!.entries[0].reason).to.match(/variant.*mismatch|double|string/i)
    })
  })
})
