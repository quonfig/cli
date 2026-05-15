import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import type {MigrationReportData} from '../../src/migrate/migration-report.js'
import {pushMigrationToCloud} from '../../src/migrate/push-to-cloud.js'
import type {LegacyChange} from '../../src/migrate/source.js'
import {
  __resetSleepForTests,
  __setSleepForTests,
  setLaunchDarklyBaseUrl,
} from '../../src/migrate/sources/launchdarkly/api.js'
import {
  __resetLaunchDarklySourceForTests,
  launchdarklySource,
  setLaunchDarklyFullSummary,
} from '../../src/migrate/sources/launchdarkly.js'

/**
 * Epic 6 (plan §4.1, §10) — `--full-summary --from launchdarkly` reifies every
 * historical flag change in the LaunchDarkly audit log into its own git commit,
 * authored as the original LD member with the original timestamp and the audit
 * entry's `shortDescription` as the message. This is the end-to-end integration:
 * MSW-mocked LD audit endpoints → the real `launchdarklySource` (with
 * full-summary on) → `pushMigrationToCloud({fullHistory: true})` → on-disk git
 * log on a bare remote.
 */

const TEST_BASE_URL = 'https://ld.test/api/v2'
const DAY_MS = 86_400_000

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function flagVersion(key: string, on: boolean) {
  // The `description` differs by version so the converter produces strictly
  // different JSON for each audit entry — otherwise consecutive audit commits
  // with identical content would collapse (cloneAndStackPush skips no-op
  // commits, qfg-3uks), and we wouldn't see the per-change history we're
  // asserting on.
  return {
    description: on ? 'demo-flag is on' : 'demo-flag is off',
    environments: {production: {fallthrough: {variation: on ? 0 : 1}, on}},
    key,
    kind: 'boolean',
    variations: [{value: true}, {value: false}],
  }
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

interface GitLogEntry {
  authorEmail: string
  authorIsoDate: string
  authorName: string
  subject: string
}

function readLog(dir: string): GitLogEntry[] {
  const shas = git(dir, 'log', '--reverse', '--pretty=format:%H').split('\n').filter(Boolean)
  return shas.map((sha) => {
    const fields = git(dir, 'show', '-s', '--pretty=format:%an%x09%ae%x09%aI%x09%s', sha).split('\t')
    const [authorName, authorEmail, authorIsoDate, ...subjectParts] = fields
    return {authorEmail, authorIsoDate, authorName, subject: subjectParts.join('\t')}
  })
}

describe('migrate/sources/launchdarkly — --full-summary end-to-end (Epic 6)', function () {
  // Per-change commits spawn one git process each; Windows CI is markedly
  // slower at process spawn, so generously above the .mocharc default.
  this.timeout(60_000)

  let server: ReturnType<typeof setupServer>
  let rootTmp: string

  beforeEach(() => {
    setLaunchDarklyBaseUrl(TEST_BASE_URL)
    __setSleepForTests(async () => {})
    __resetLaunchDarklySourceForTests()
    rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-fullsummary-'))
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
    fs.rmSync(rootTmp, {force: true, recursive: true})
  })

  it('reifies LD audit entries into per-change commits authored by the original LD member, chronologically', async () => {
    // Git's commit-date format is second-precision; align the audit timestamps
    // to whole seconds so the round-trip through ISO-8601 is exact.
    const now = Math.floor(Date.now() / 1000) * 1000
    const t1 = now - 2 * DAY_MS
    const t2 = now - DAY_MS

    server = setupServer(
      // Project probe (validateAuth + segment fetch).
      http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
        HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
      ),
      // Audit listing — first page two entries newest-first, then empty.
      http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
        const u = new URL(request.url)
        const before = u.searchParams.get('before')
        const spec = u.searchParams.get('spec')
        // Retention pre-flight probes use boundary timestamps far older than t1;
        // only the unbounded full walk (no before) should return the two real
        // entries. Bracket probes return the two entries too — but the walk's
        // empty page on the second iteration is what terminates it.
        if (before && Number(before) <= t1) return HttpResponse.json({items: []})
        if (!spec) return HttpResponse.json({items: []})
        return HttpResponse.json({
          items: [
            {_id: 'a2', date: t2},
            {_id: 'a1', date: t1},
          ],
        })
      }),
      http.get(`${TEST_BASE_URL}/auditlog/:id`, ({params}) => {
        const id = params.id as string
        if (id === 'a1') {
          return HttpResponse.json({
            _id: 'a1',
            currentVersion: flagVersion('demo-flag', false),
            date: t1,
            member: {email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace'},
            shortDescription: 'created demo-flag off',
          })
        }

        return HttpResponse.json({
          _id: 'a2',
          currentVersion: flagVersion('demo-flag', true),
          date: t2,
          member: {email: 'grace@example.com', firstName: 'Grace', lastName: 'Hopper'},
          shortDescription: 'turned demo-flag on',
        })
      }),
      http.get(`${TEST_BASE_URL}/segments/default/production`, () => HttpResponse.json({items: []})),
    )
    server.listen({onUnhandledRequest: 'error'})

    // Bare remote + initial seed commit, mirroring push-to-cloud.test.ts.
    const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
    git(remoteDir, 'init', '--bare', '--initial-branch=main')
    const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
    git(seed, 'init', '--initial-branch=main')
    git(seed, 'config', 'user.email', 'seed@test')
    git(seed, 'config', 'user.name', 'Seed')
    fs.writeFileSync(path.join(seed, 'quonfig.json'), JSON.stringify({environments: []}, null, 2) + '\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'initial')
    git(seed, 'remote', 'add', 'origin', remoteDir)
    git(seed, 'push', 'origin', 'main')

    // pushMigrationToCloud clones into an empty/non-existent dir; the audit
    // walk's resume cursor lives in os.tmpdir, so it does not clobber this.
    const cloneDir = fs.mkdtempSync(path.join(rootTmp, 'clone-'))

    setLaunchDarklyFullSummary(true)
    await launchdarklySource.validateAuth('token')
    const environments = await launchdarklySource.listEnvironments()

    const changes: LegacyChange[] = []
    for await (const change of launchdarklySource.fetchChanges(null)) {
      changes.push(change)
    }

    // Sanity — only the two audit-derived flag changes (segments are empty here).
    expect(changes.map((c) => c.changedAt)).to.deep.equal([t1, t2])

    await pushMigrationToCloud({
      changes,
      environments,
      fullHistory: true,
      importState: {lastProcessedAt: t2, source: 'launchdarkly'},
      localDir: cloneDir,
      remoteUrl: remoteDir,
      reportData: emptyReport(),
      source: launchdarklySource,
    })

    const reader = fs.mkdtempSync(path.join(rootTmp, 'read-'))
    git(reader, 'clone', remoteDir, '.')
    const log = readLog(reader)

    // initial + a1 + a2 + final state-file commit.
    expect(log).to.have.length(4)
    expect(log[0].subject).to.equal('initial')

    expect(log[1].subject).to.equal('created demo-flag off')
    expect(log[1].authorName).to.equal('Ada Lovelace')
    expect(log[1].authorEmail).to.equal('ada@example.com')
    expect(new Date(log[1].authorIsoDate).getTime()).to.equal(t1)

    expect(log[2].subject).to.equal('turned demo-flag on')
    expect(log[2].authorName).to.equal('Grace Hopper')
    expect(log[2].authorEmail).to.equal('grace@example.com')
    expect(new Date(log[2].authorIsoDate).getTime()).to.equal(t2)

    // Final commit is migrator-attributed bookkeeping (state file + report).
    expect(log[3].authorEmail).to.equal('migrator@quonfig.com')

    // Final on-disk content matches the latest audit entry (flag on).
    const finalFlag = JSON.parse(fs.readFileSync(path.join(reader, 'feature-flags/demo-flag.json'), 'utf8'))
    const prodEnv = finalFlag.environments.find((e: {id: string}) => e.id === 'production')
    expect(prodEnv).to.not.equal(undefined)
  })

  it('checkpoints the audit walk and resumes from the persisted before cursor on the next run', async () => {
    const baseTs = 5_000_000
    server = setupServer(
      http.get(`${TEST_BASE_URL}/projects/default/environments`, () =>
        HttpResponse.json({items: [{key: 'production', name: 'Production'}]}),
      ),
      // Retention probes (with `before` near the boundaries) return nothing —
      // we only care about the walk's `before` cursor and the checkpoint write.
      http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
        const before = new URL(request.url).searchParams.get('before')
        if (!before) {
          // Walk's first (newest-first) page.
          return HttpResponse.json({
            items: [
              {_id: 'a3', date: baseTs + 3000},
              {_id: 'a2', date: baseTs + 2000},
            ],
          })
        }

        return HttpResponse.json({items: []})
      }),
      http.get(`${TEST_BASE_URL}/auditlog/:id`, ({params}) => {
        const id = params.id as string
        const date = id === 'a2' ? baseTs + 2000 : baseTs + 3000
        return HttpResponse.json({
          _id: id,
          currentVersion: flagVersion('demo-flag', true),
          date,
          member: {email: 'ada@example.com'},
          shortDescription: `change ${id}`,
        })
      }),
      http.get(`${TEST_BASE_URL}/segments/default/production`, () => HttpResponse.json({items: []})),
    )
    server.listen({onUnhandledRequest: 'error'})

    setLaunchDarklyFullSummary(true)
    await launchdarklySource.validateAuth('token')

    // Drain the walk so onCheckpoint fires.
    const changes: LegacyChange[] = []
    for await (const change of launchdarklySource.fetchChanges(null)) {
      changes.push(change)
    }

    expect(changes.map((c) => c.changedAt)).to.deep.equal([baseTs + 2000, baseTs + 3000])

    // The walk completed cleanly, so the checkpoint MUST have been cleared —
    // otherwise a subsequent run would re-resume from a stale cursor and skip
    // entries newer than the persisted before. The checkpoint lives in
    // os.tmpdir keyed by project; the source reset utility wipes it too.
    const checkpointPath = path.join(os.tmpdir(), 'qfg-ld-audit-default.json')
    expect(fs.existsSync(checkpointPath)).to.equal(false)
  })
})
