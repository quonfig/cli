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
import {setLaunchDarklyBaseUrl} from '../../src/migrate/sources/launchdarkly/api.js'
import {__resetLaunchDarklySourceForTests, launchdarklySource} from '../../src/migrate/sources/launchdarkly.js'

/**
 * Epic 5 (plan §7, §10) — wire the LaunchDarkly source into both write modes
 * and verify the conversion report lands in MIGRATION_REPORT.md.
 *
 * Both write paths (`applyLocalMigration` / `pushMigrationToCloud`) are
 * source-agnostic, so the LaunchDarkly source inherits them by emitting
 * `QuonfigFile[]`. The part that is *not* free is reporting: the converter's
 * `ConversionReport` (re-bucketed rollouts, dropped prerequisites, …) has to
 * be threaded through `getConversionNotes()` into the report file. This suite
 * mirrors the `launchdarkly-source.test.ts` MSW harness and asserts the
 * on-disk MIGRATION_REPORT.md for each mode.
 */

const TEST_BASE_URL = 'https://ld.test/api/v2'

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

/**
 * One environment, one boolean flag whose fallthrough is a percentage rollout
 * (→ `rebucketed-rollout` note) and which also carries a prerequisite (→
 * `dropped-prerequisite` note). Exercises both report sections at once.
 */
function ldServer(): ReturnType<typeof setupServer> {
  return setupServer(
    http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
      HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
    ),
    http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
    http.get(`${TEST_BASE_URL}/flags/default`, () =>
      HttpResponse.json({
        items: [
          {
            environments: {
              production: {
                fallthrough: {
                  rollout: {
                    variations: [
                      {variation: 0, weight: 60_000},
                      {variation: 1, weight: 40_000},
                    ],
                  },
                },
                on: true,
                prerequisites: [{key: 'kill-switch', variation: 0}],
              },
            },
            key: 'gradual-rollout',
            kind: 'boolean',
            variations: [{value: true}, {value: false}],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/segments/default/production`, () => HttpResponse.json({items: []})),
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
    source: 'launchdarkly',
    unsupportedFeatures: [],
  }
}

async function collectChanges(): Promise<{changes: LegacyChange[]; environments: string[]}> {
  await launchdarklySource.validateAuth('token')
  const environments = await launchdarklySource.listEnvironments()
  const changes: LegacyChange[] = []
  for await (const change of launchdarklySource.fetchChanges(null)) {
    changes.push(change)
  }

  return {changes, environments}
}

describe('migrate/sources/launchdarkly — both write modes + reporting (Epic 5)', () => {
  let server: ReturnType<typeof setupServer>
  let rootTmp: string

  beforeEach(() => {
    setLaunchDarklyBaseUrl(TEST_BASE_URL)
    __resetLaunchDarklySourceForTests()
    rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-write-modes-'))
    server = ldServer()
    server.listen({onUnhandledRequest: 'error'})
  })

  afterEach(() => {
    if (server) server.close()
    fs.rmSync(rootTmp, {force: true, recursive: true})
  })

  describe('local --dir mode (applyLocalMigration)', () => {
    it('writes the converted flag and a MIGRATION_REPORT.md with the re-bucketed + conversion-notes sections', async () => {
      const localDir = path.join(rootTmp, 'workspace')
      const {changes, environments} = await collectChanges()

      const result = await applyLocalMigration({
        changes,
        environments,
        importState: {source: 'launchdarkly'},
        localDir,
        reportData: emptyReport(),
        source: launchdarklySource,
      })

      expect(result.committed).to.equal(true)
      // Flag file landed on disk via the source-agnostic write path.
      expect(fs.existsSync(path.join(localDir, 'feature-flags', 'gradual-rollout.json'))).to.equal(true)

      const report = fs.readFileSync(path.join(localDir, 'MIGRATION_REPORT.md'), 'utf8')
      // The required "users will be re-bucketed" section names the rollout flag (plan §5.4).
      expect(report).to.match(/^##\s*Users will be re-bucketed/m)
      const rebucketSection = report.slice(report.indexOf('## Users will be re-bucketed'))
      expect(rebucketSection).to.include('gradual-rollout')
      // The dropped prerequisite is surfaced under Conversion notes — not silently lost.
      expect(report).to.match(/^##\s*Conversion notes/m)
      const notesSection = report.slice(report.indexOf('## Conversion notes'))
      expect(notesSection).to.include('gradual-rollout')
      expect(notesSection).to.match(/prerequisite/i)
      // qfg-bth9: the Follow-up checklist is derived from the conversion notes —
      // dropped prerequisites land in must-fix-before-cutover, rebucketed
      // rollouts land in review-post-cutover. Each item names the affected
      // flag/segment.
      const checklist = report.slice(report.indexOf('## Follow-up checklist'))
      const [mustFix, postCutover] = checklist.split('### Review post-cutover')
      expect(mustFix).to.match(/^- \[ ].*gradual-rollout.*prerequisite/im)
      expect(postCutover).to.match(/^- \[ ].*gradual-rollout.*re-bucket/im)
    })

    it('omits both sections when the source produced no conversion notes', async () => {
      // A flag with a plain single-variation fallthrough and no prerequisites.
      server.close()
      server = setupServer(
        http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
          HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
        ),
        http.get(`${TEST_BASE_URL}/projects/default/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${TEST_BASE_URL}/flags/default`, () =>
          HttpResponse.json({
            items: [
              {
                environments: {production: {fallthrough: {variation: 0}, on: true}},
                key: 'plain-flag',
                kind: 'boolean',
                variations: [{value: true}, {value: false}],
              },
            ],
          }),
        ),
        http.get(`${TEST_BASE_URL}/segments/default/production`, () => HttpResponse.json({items: []})),
      )
      server.listen({onUnhandledRequest: 'error'})
      __resetLaunchDarklySourceForTests()

      const localDir = path.join(rootTmp, 'plain-workspace')
      const {changes, environments} = await collectChanges()
      await applyLocalMigration({
        changes,
        environments,
        importState: {source: 'launchdarkly'},
        localDir,
        reportData: emptyReport(),
        source: launchdarklySource,
      })

      const report = fs.readFileSync(path.join(localDir, 'MIGRATION_REPORT.md'), 'utf8')
      expect(report).to.not.match(/Users will be re-bucketed/)
      expect(report).to.not.match(/^##\s*Conversion notes/m)
      // qfg-bth9: with no lossy events, both follow-up sub-sections still render `_(none)_`.
      const checklist = report.slice(report.indexOf('## Follow-up checklist'))
      const [mustFix, postCutover] = checklist.split('### Review post-cutover')
      expect(mustFix).to.include('_(none)_')
      expect(postCutover).to.include('_(none)_')
    })

    it('initializes a fresh git repo at the target when --dir is inside an ancestor repo (qfg-wu85)', async () => {
      // Regression test for the isGitRepo walk-up bug: `git rev-parse --git-dir`
      // climbs the filesystem, so when a user runs `qfg migrate --dir ./sub` from
      // inside their own repo, the migrator used to "reuse" the ancestor repo
      // and commit the migration into it (with the wrong author and sweeping in
      // any unrelated uncommitted changes). The fix: scope the check to the
      // target dir via `--show-toplevel`.
      const ancestor = fs.mkdtempSync(path.join(rootTmp, 'ancestor-'))
      run(ancestor, 'init', '--initial-branch=main')
      run(ancestor, 'config', 'user.email', 'ancestor@test')
      run(ancestor, 'config', 'user.name', 'Ancestor')
      // An unrelated uncommitted file sitting in the ancestor — would have been
      // swept into the bad migration commit pre-fix.
      fs.writeFileSync(path.join(ancestor, 'unrelated.txt'), 'do not commit me\n')
      run(ancestor, 'add', 'unrelated.txt')
      const ancestorHeadBefore = (() => {
        try {
          return run(ancestor, 'rev-parse', 'HEAD')
        } catch {
          return null // no commits yet, expected for a fresh init
        }
      })()

      const localDir = path.join(ancestor, 'workspace')
      const {changes, environments} = await collectChanges()
      const result = await applyLocalMigration({
        changes,
        environments,
        importState: {source: 'launchdarkly'},
        localDir,
        reportData: emptyReport(),
        source: launchdarklySource,
      })

      expect(result.committed).to.equal(true)
      // The target dir is its OWN git repo, not the ancestor's. --show-prefix
      // returns the empty string only when we're standing at the toplevel,
      // sidestepping macOS /var-vs-/private/var symlinks + Windows 8.3 paths.
      expect(run(localDir, 'rev-parse', '--show-prefix')).to.equal('')
      // The migration commit message lives on the target's HEAD.
      expect(run(localDir, 'log', '-1', '--pretty=%s')).to.match(/launchdarkly/i)
      // The ancestor's HEAD is unchanged — nothing was committed there.
      const ancestorHeadAfter = (() => {
        try {
          return run(ancestor, 'rev-parse', 'HEAD')
        } catch {
          return null
        }
      })()
      expect(ancestorHeadAfter).to.equal(ancestorHeadBefore)
      // The unrelated staged file is still staged, never landed in any commit.
      expect(run(ancestor, 'status', '--porcelain', 'unrelated.txt')).to.match(/^A\s+unrelated\.txt/)
    })
  })

  describe('--push cloud mode (pushMigrationToCloud)', () => {
    it('pushes the converted workspace and the pushed MIGRATION_REPORT.md carries the re-bucketed section', async () => {
      // Bare remote seeded with an initial commit, mirroring push-to-cloud.test.ts.
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
        importState: {source: 'launchdarkly'},
        localDir: fs.mkdtempSync(path.join(rootTmp, 'clone-')),
        remoteUrl: remoteDir,
        reportData: emptyReport(),
        source: launchdarklySource,
      })

      expect(result.committed).to.equal(true)

      const readClone = fs.mkdtempSync(path.join(rootTmp, 'read-'))
      run(readClone, 'clone', remoteDir, '.')
      expect(fs.existsSync(path.join(readClone, 'feature-flags', 'gradual-rollout.json'))).to.equal(true)

      const report = fs.readFileSync(path.join(readClone, 'MIGRATION_REPORT.md'), 'utf8')
      expect(report).to.match(/^##\s*Users will be re-bucketed/m)
      expect(report.slice(report.indexOf('## Users will be re-bucketed'))).to.include('gradual-rollout')
      expect(report).to.match(/^##\s*Conversion notes/m)
    })
  })
})
