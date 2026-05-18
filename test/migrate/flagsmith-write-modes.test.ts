import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {applyLocalMigration} from '../../src/migrate/local-write.js'
import type {MigrationReportData} from '../../src/migrate/migration-report.js'
import {pushMigrationToCloud} from '../../src/migrate/push-to-cloud.js'
import type {LegacyChange} from '../../src/migrate/source.js'
import {__resetSleepForTests, __setSleepForTests, setFlagsmithBaseUrl} from '../../src/migrate/sources/flagsmith/api.js'
import {
  __resetFlagsmithSourceForTests,
  flagsmithSource,
  setFlagsmithProjectId,
} from '../../src/migrate/sources/flagsmith.js'

/**
 * Epic 5 (plan §7, §10) — wire the Flagsmith source into both write modes and
 * verify the conversion report lands in MIGRATION_REPORT.md.
 *
 * Mirrors `launchdarkly-write-modes.test.ts`. Both write paths
 * (`applyLocalMigration` / `pushMigrationToCloud`) are source-agnostic, so the
 * Flagsmith source inherits them by emitting `QuonfigFile[]`. The part this
 * suite exercises is **reporting**: every D-F1..D-F6 disposition has to land
 * in the per-section summary in MIGRATION_REPORT.md, and the Flagsmith-
 * specific behavioral-differences appendix has to render.
 */

const TEST_BASE_URL = 'https://flagsmith.test/api/v1'
const PROJECT_ID = '38856'

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

/**
 * MSW server seeded with a realistic Flagsmith corpus — one MV feature
 * (exercises D-F2 identity overrides + §5.4 re-bucketing), one non-bool
 * feature with `enabled=false` (D-F1 coercion), one segment with a MODULO
 * condition (D-F3 dropped-rule), and one segment with a trait reference
 * (D-F6 identity-traits).
 */
function flagsmithServer(): ReturnType<typeof setupServer> {
  return setupServer(
    http.get(`${TEST_BASE_URL}/projects/${PROJECT_ID}/`, () =>
      HttpResponse.json({
        id: Number(PROJECT_ID),
        name: 'Test1',
        only_allow_lower_case_feature_names: true,
        organisation: 1,
        use_edge_identities: true,
        use_v2_feature_versioning: true,
        uuid: 'u-project',
      }),
    ),
    http.get(`${TEST_BASE_URL}/environments/`, () =>
      HttpResponse.json({
        count: 2,
        next: null,
        previous: null,
        results: [
          {api_key: 'apk-dev', id: 90, name: 'Development', project: Number(PROJECT_ID), uuid: 'u-d'},
          {api_key: 'apk-prod', id: 91, name: 'Production', project: Number(PROJECT_ID), uuid: 'u-p'},
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/projects/${PROJECT_ID}/tags/`, () =>
      HttpResponse.json({count: 0, next: null, previous: null, results: []}),
    ),
    http.get(`${TEST_BASE_URL}/projects/${PROJECT_ID}/features/`, () =>
      HttpResponse.json({
        count: 2,
        next: null,
        previous: null,
        results: [
          // A MULTIVARIATE feature — exercises plan §5.4 re-bucketing note.
          {
            default_enabled: true,
            id: 201,
            is_archived: false,
            multivariate_options: [
              {
                boolean_value: null,
                default_percentage_allocation: 50,
                id: 11,
                integer_value: null,
                string_value: 'control',
                type: 'unicode',
                uuid: 'u-mv-1',
              },
              {
                boolean_value: null,
                default_percentage_allocation: 50,
                id: 12,
                integer_value: null,
                string_value: 'treatment',
                type: 'unicode',
                uuid: 'u-mv-2',
              },
            ],
            name: 'fx-mv-experiment',
            project: Number(PROJECT_ID),
            tags: [],
            type: 'MULTIVARIATE',
            uuid: 'u-mv',
          },
          // A non-boolean feature `enabled=false` in dev — D-F1 coercion.
          {
            default_enabled: false,
            id: 202,
            is_archived: false,
            multivariate_options: [],
            name: 'fx-string-disabled',
            project: Number(PROJECT_ID),
            tags: [],
            type: 'STANDARD',
            uuid: 'u-sd',
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/features/featurestates/`, ({request}) => {
      const url = new URL(request.url)
      const envId = url.searchParams.get('environment')
      if (envId === '90') {
        return HttpResponse.json({
          count: 2,
          next: null,
          previous: null,
          results: [
            {
              enabled: true,
              environment: 90,
              feature: 201,
              feature_segment: null,
              feature_state_value: {boolean_value: null, integer_value: null, string_value: null, type: 'unicode'},
              id: 9001,
              multivariate_feature_state_values: [],
              uuid: 'us-1',
            },
            {
              // D-F1: non-bool feature, enabled=false in this env.
              enabled: false,
              environment: 90,
              feature: 202,
              feature_segment: null,
              feature_state_value: {
                boolean_value: null,
                integer_value: null,
                string_value: 'fallback',
                type: 'unicode',
              },
              id: 9002,
              multivariate_feature_state_values: [],
              uuid: 'us-2',
            },
          ],
        })
      }

      return HttpResponse.json({
        count: 2,
        next: null,
        previous: null,
        results: [
          {
            enabled: true,
            environment: 91,
            feature: 201,
            feature_segment: null,
            feature_state_value: {boolean_value: null, integer_value: null, string_value: null, type: 'unicode'},
            id: 9101,
            multivariate_feature_state_values: [],
            uuid: 'us-3',
          },
          {
            enabled: true,
            environment: 91,
            feature: 202,
            feature_segment: null,
            feature_state_value: {
              boolean_value: null,
              integer_value: null,
              string_value: 'live',
              type: 'unicode',
            },
            id: 9102,
            multivariate_feature_state_values: [],
            uuid: 'us-4',
          },
        ],
      })
    }),
    http.get(`${TEST_BASE_URL}/projects/${PROJECT_ID}/segments/`, () =>
      HttpResponse.json({
        count: 2,
        next: null,
        previous: null,
        results: [
          {
            id: 1_127_682,
            name: 'fx-seg-modulo',
            project: Number(PROJECT_ID),
            // D-F3: a MODULO condition gets dropped with a skipped-rule note.
            rules: [{conditions: [{operator: 'MODULO', property: 'user_id', value: '10|3'}], rules: [], type: 'ALL'}],
            uuid: 'us-seg-1',
          },
          {
            id: 1_127_683,
            name: 'fx-seg-traits',
            project: Number(PROJECT_ID),
            // D-F6: this exercises identity-traits-referenced — `plan` and `region`.
            rules: [
              {
                conditions: [
                  {operator: 'EQUAL', property: 'plan', value: 'enterprise'},
                  {operator: 'EQUAL', property: 'region', value: 'us-west'},
                ],
                rules: [],
                type: 'ALL',
              },
            ],
            uuid: 'us-seg-2',
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/environments/apk-dev/edge-identity-overrides`, () => HttpResponse.json({results: []})),
    http.get(`${TEST_BASE_URL}/environments/apk-prod/edge-identity-overrides`, () => HttpResponse.json({results: []})),
  )
}

function emptyReport(): MigrationReportData {
  return {
    cleanMappings: [],
    counts: {
      configsMigrated: 0,
      environmentsMapped: 0,
      flagsMigrated: 0,
      itemsSkipped: 0,
      logLevelsMigrated: 0,
      schemasMigrated: 0,
      segmentsMigrated: 0,
    },
    dryRun: false,
    environmentMap: [],
    followUp: {mustFixBeforeCutover: [], reviewPostCutover: []},
    identifierMap: {},
    lossyMappings: [],
    source: 'flagsmith',
    unsupportedFeatures: [],
  }
}

async function collectChanges(): Promise<{changes: LegacyChange[]; environments: string[]}> {
  await flagsmithSource.validateAuth('token')
  const environments = await flagsmithSource.listEnvironments()
  const changes: LegacyChange[] = []
  for await (const change of flagsmithSource.fetchChanges(null)) {
    changes.push(change)
  }

  return {changes, environments}
}

describe('migrate/sources/flagsmith — both write modes + reporting (Epic 5)', () => {
  let server: ReturnType<typeof setupServer>
  let rootTmp: string

  beforeEach(() => {
    setFlagsmithBaseUrl(TEST_BASE_URL)
    __setSleepForTests(async () => {})
    __resetFlagsmithSourceForTests()
    setFlagsmithProjectId(PROJECT_ID)
    rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flagsmith-write-modes-'))
    server = flagsmithServer()
    server.listen({onUnhandledRequest: 'error'})
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
    fs.rmSync(rootTmp, {force: true, recursive: true})
  })

  describe('local --dir mode (applyLocalMigration)', () => {
    it('writes the converted Flagsmith workspace + MIGRATION_REPORT.md with every D-F* section the corpus exercises', async () => {
      const localDir = path.join(rootTmp, 'workspace')
      const {changes, environments} = await collectChanges()

      const result = await applyLocalMigration({
        changes,
        environments,
        importState: {source: 'flagsmith'},
        localDir,
        reportData: emptyReport(),
        source: flagsmithSource,
      })

      expect(result.committed).to.equal(true)
      // Flag files landed via the source-agnostic write path.
      expect(fs.existsSync(path.join(localDir, 'feature-flags', 'fx-mv-experiment.json'))).to.equal(true)
      expect(fs.existsSync(path.join(localDir, 'feature-flags', 'fx-string-disabled.json'))).to.equal(true)
      expect(fs.existsSync(path.join(localDir, 'segments', 'fx-seg-modulo.json'))).to.equal(true)
      expect(fs.existsSync(path.join(localDir, 'segments', 'fx-seg-traits.json'))).to.equal(true)

      const report = fs.readFileSync(path.join(localDir, 'MIGRATION_REPORT.md'), 'utf8')

      // Plan §5.4 "users will be re-bucketed" lists every MV feature.
      expect(report).to.match(/^##\s*Users will be re-bucketed/m)
      const rebucketSection = report.slice(report.indexOf('## Users will be re-bucketed'))
      expect(rebucketSection).to.include('fx-mv-experiment')
      expect(rebucketSection).to.match(/flagsmith/i)

      // D-F1: `enabled=false` on a non-boolean feature surfaces under Coerced sentinel rule values.
      expect(report).to.match(/^##\s*Coerced sentinel rule values/m)
      const coercedSection = report.slice(report.indexOf('## Coerced sentinel rule values'))
      expect(coercedSection).to.include('fx-string-disabled')
      // The env bucket is the slugified env name, not the api_key sentinel.
      expect(coercedSection).to.match(/development|production/i)

      // D-F3: MODULO operator → skipped-rule note under Conversion notes.
      expect(report).to.match(/^##\s*Conversion notes/m)
      const notesSection = report.slice(report.indexOf('## Conversion notes'))
      expect(notesSection).to.match(/skipped rules/i)
      expect(notesSection).to.include('fx-seg-modulo')
      expect(notesSection).to.match(/MODULO/)

      // D-F6: identity-trait extraction reports `plan` and `region` from fx-seg-traits.
      expect(notesSection).to.match(/identity traits referenced by segment rules/i)
      expect(notesSection).to.include('`plan`')
      expect(notesSection).to.include('`region`')
      expect(notesSection).to.include('fx-seg-traits')

      // Behavioral-differences appendix is the Flagsmith flavor.
      const appendix = report.slice(report.indexOf('## Behavioral differences post-cutover'))
      expect(appendix).to.match(/enabled=false/)
      expect(appendix).to.match(/soft-deleted/i)
      expect(appendix).to.match(/multivariate/i)

      // Environment mapping table renders both source envs.
      const tableStart = report.indexOf('## Environment mapping table')
      const tableSection = report.slice(tableStart, report.indexOf('\n## ', tableStart + 1))
      expect(tableSection).to.match(/\|\s*Development\s*\|\s*development\s*\|/)
      expect(tableSection).to.match(/\|\s*Production\s*\|\s*production\s*\|/)
    })

    it('exit code is 0 even with warnings (matches LD policy — warnings are not errors in v1)', async () => {
      // Verified at the API level: applyLocalMigration returns successfully and
      // the command-level `run()` returns its payload (no throw) when warnings
      // exist. The migrate command's warn() calls do not affect exit code.
      const localDir = path.join(rootTmp, 'warn-workspace')
      const {changes, environments} = await collectChanges()

      const result = await applyLocalMigration({
        changes,
        environments,
        importState: {source: 'flagsmith'},
        localDir,
        reportData: emptyReport(),
        source: flagsmithSource,
      })

      // committed === true demonstrates no throw and a clean commit even though
      // the source emitted D-F1 / D-F3 / D-F6 / re-bucketed notes (warnings).
      expect(result.committed).to.equal(true)
      // Sanity: the coerced sentinel summary IS populated, confirming
      // warnings happened on this run.
      expect(result.coercedSentinels).to.not.equal(null)
      expect(result.coercedSentinels!.total).to.be.greaterThan(0)
    })
  })

  describe('--push cloud mode (pushMigrationToCloud)', () => {
    it('pushes the converted Flagsmith workspace and the pushed MIGRATION_REPORT.md carries every section', async () => {
      // Bare remote seeded with an initial commit so the pre-receive equivalent
      // (validateWorkspace) has a starting point. Mirrors the LD write-modes test.
      const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
      run(remoteDir, 'init', '--bare', '--initial-branch=main')
      const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
      run(seed, 'init', '--initial-branch=main')
      run(seed, 'config', 'user.email', 'seed@test')
      run(seed, 'config', 'user.name', 'Seed')
      fs.writeFileSync(path.join(seed, 'quonfig.json'), JSON.stringify({environments: []}, null, 2) + '\n')
      run(seed, 'add', '.')
      run(seed, 'commit', '-m', 'initial')
      run(seed, 'remote', 'add', 'origin', remoteDir)
      run(seed, 'push', 'origin', 'main')

      const {changes, environments} = await collectChanges()
      const result = await pushMigrationToCloud({
        changes,
        environments,
        importState: {source: 'flagsmith'},
        localDir: fs.mkdtempSync(path.join(rootTmp, 'clone-')),
        remoteUrl: remoteDir,
        reportData: emptyReport(),
        source: flagsmithSource,
      })

      expect(result.committed).to.equal(true)

      const readClone = fs.mkdtempSync(path.join(rootTmp, 'read-'))
      run(readClone, 'clone', remoteDir, '.')
      expect(fs.existsSync(path.join(readClone, 'feature-flags', 'fx-mv-experiment.json'))).to.equal(true)
      expect(fs.existsSync(path.join(readClone, 'segments', 'fx-seg-traits.json'))).to.equal(true)

      const report = fs.readFileSync(path.join(readClone, 'MIGRATION_REPORT.md'), 'utf8')
      expect(report).to.match(/^##\s*Users will be re-bucketed/m)
      expect(report.slice(report.indexOf('## Users will be re-bucketed'))).to.include('fx-mv-experiment')
      expect(report).to.match(/^##\s*Conversion notes/m)
      // Flagsmith appendix
      expect(report).to.match(/^##\s*Behavioral differences post-cutover/m)
    })
  })
})
