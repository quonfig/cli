import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {pushMigrationToCloud} from '../../src/migrate/push-to-cloud.js'
import type {CommitMeta, LegacyChange, MigrationSource, QuonfigFile} from '../../src/migrate/source.js'

// qfg-wbkj: When --full-summary is on, each Launch change entry reifies into
// its own git commit, authored as the Launch user with the original
// changedAt as GIT_AUTHOR_DATE and the change `summary` as the message.
// One final state-file commit lands on top (migrator identity, now), carrying
// .qf/import-state.json + .qf/MIGRATION_REPORT.md so the audit-log commits aren't
// polluted by bookkeeping churn.

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function createBareRemote(rootTmp: string): string {
  const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
  run(remoteDir, 'init', '--bare', '--initial-branch=main')
  return remoteDir
}

function seedRemote(remoteDir: string, rootTmp: string): void {
  const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
  run(seed, 'init', '--initial-branch=main')
  run(seed, 'config', 'user.email', 'seed@test')
  run(seed, 'config', 'user.name', 'Seed')
  fs.writeFileSync(path.join(seed, 'README.md'), '# workspace\n')
  run(seed, 'add', '.')
  run(seed, 'commit', '-m', 'initial')
  run(seed, 'remote', 'add', 'origin', remoteDir)
  run(seed, 'push', 'origin', 'main')
}

function cloneForRead(remoteDir: string, rootTmp: string): string {
  const tmp = fs.mkdtempSync(path.join(rootTmp, 'read-'))
  run(tmp, 'clone', remoteDir, '.')
  return tmp
}

interface GitLogEntry {
  authorEmail: string
  authorIsoDate: string
  authorName: string
  changedPaths: string[]
  subject: string
}

function readLog(dir: string): GitLogEntry[] {
  const shas = run(dir, 'log', '--reverse', '--pretty=format:%H').split('\n').filter(Boolean)
  return shas.map((sha) => {
    const fields = run(dir, 'show', '-s', '--pretty=format:%an%x09%ae%x09%aI%x09%s', sha).split('\t')
    const [authorName, authorEmail, authorIsoDate, ...subjectParts] = fields
    const subject = subjectParts.join('\t')
    const changedPaths = run(dir, 'show', '--name-only', '--pretty=format:', sha)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    return {authorName, authorEmail, authorIsoDate, subject, changedPaths}
  })
}

function validConfig(key: string, value = true): string {
  return (
    JSON.stringify(
      {
        default: {
          rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value}}],
        },
        environments: [],
        key,
        type: 'config',
        valueType: 'bool',
      },
      null,
      2,
    ) + '\n'
  )
}

function validFeatureFlag(key: string, value = true): string {
  return (
    JSON.stringify(
      {
        default: {
          rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value}}],
        },
        environments: [],
        key,
        type: 'feature_flag',
        valueType: 'bool',
        variants: [],
      },
      null,
      2,
    ) + '\n'
  )
}

interface FakeChange {
  changedAt: number
  changedBy: {fullName?: string; email: string}
  key: string
  summary?: string
  value: boolean
}

/**
 * Fake source whose translate() emits a single feature_flag file with the
 * change's `value` baked in, and whose getCommitMeta() exposes the Launch-
 * style author/date/message that push-to-cloud needs in full-history mode.
 */
function makeFakeAuditSource(perChange: Map<string, FakeChange>): MigrationSource {
  return {
    async *fetchChanges() {
      // Not used by these tests; changes are fed directly into pushMigrationToCloud.
    },
    getCommitMeta(change: LegacyChange): CommitMeta | null {
      const id = `${change.key}@${change.changedAt}`
      const meta = perChange.get(id)
      if (!meta) return null
      return {
        author: {email: meta.changedBy.email, name: meta.changedBy.fullName ?? meta.changedBy.email},
        date: meta.changedAt,
        message: meta.summary ?? `migrator: update ${meta.key}`,
      }
    },
    async listEnvironments() {
      return []
    },
    name: 'fake',
    translate(change: LegacyChange): QuonfigFile[] {
      const id = `${change.key}@${change.changedAt}`
      const fc = perChange.get(id)
      if (!fc) return []
      return [{contents: validFeatureFlag(fc.key, fc.value), path: `feature-flags/${fc.key}.json`}]
    },
    async validateAuth() {
      /* noop */
    },
  }
}

function makeChange(key: string, changedAt: number): LegacyChange {
  return {changedAt, key, raw: {}, source: 'fake'}
}

function emptyReport(): Parameters<typeof pushMigrationToCloud>[0]['reportData'] {
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
    source: 'fake',
    unsupportedFeatures: [],
  }
}

describe('migrate --full-summary: per-change audit-log commits (qfg-wbkj)', function () {
  // Each test spawns dozens of git processes (bare init, seed, per-change
  // commits, clone, readLog's git-show fan-out). Process spawn is markedly
  // slower on Windows CI runners, pushing past the 10s .mocharc default.
  this.timeout(60_000)

  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-wbkj-'))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('multi-change on one flag lands as N commits in chronological order with Launch author + date + summary', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {fullName: 'Ada Lovelace', email: 'ada@example.com'}
    const grace = {fullName: 'Grace Hopper', email: 'grace@example.com'}
    const linus = {fullName: 'Linus T', email: 'linus@example.com'}

    const perChange = new Map<string, FakeChange>([
      ['flag-x@1000', {key: 'flag-x', changedAt: 1000, changedBy: ada, summary: 'create flag-x off', value: false}],
      ['flag-x@2000', {key: 'flag-x', changedAt: 2000, changedBy: grace, summary: 'flip flag-x on', value: true}],
      [
        'flag-x@3000',
        {key: 'flag-x', changedAt: 3000, changedBy: linus, summary: 'flip flag-x off again', value: false},
      ],
    ])

    await pushMigrationToCloud({
      changes: [makeChange('flag-x', 1000), makeChange('flag-x', 2000), makeChange('flag-x', 3000)],
      environments: ['production'],
      fullHistory: true,
      importState: {lastProcessedAt: 3000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeAuditSource(perChange),
    })

    const reader = cloneForRead(remote, root)
    const log = readLog(reader)
    // initial + 3 audit + 1 state-file
    expect(log).to.have.length(5)

    const [initial, t1, t2, t3, final] = log
    expect(initial.subject).to.equal('initial')

    expect(t1.subject).to.equal('create flag-x off')
    expect(t1.authorName).to.equal('Ada Lovelace')
    expect(t1.authorEmail).to.equal('ada@example.com')
    expect(new Date(t1.authorIsoDate).getTime()).to.equal(1000)
    expect(t1.changedPaths).to.deep.equal(['feature-flags/flag-x.json'])

    expect(t2.subject).to.equal('flip flag-x on')
    expect(t2.authorName).to.equal('Grace Hopper')
    expect(new Date(t2.authorIsoDate).getTime()).to.equal(2000)

    expect(t3.subject).to.equal('flip flag-x off again')
    expect(new Date(t3.authorIsoDate).getTime()).to.equal(3000)

    // Final commit is the state-file bookkeeping
    expect(final.changedPaths).to.include.members(['.qf/import-state.json', '.qf/MIGRATION_REPORT.md'])
    expect(final.changedPaths).to.not.include('feature-flags/flag-x.json')

    // Latest content matches the final change (false)
    const finalFlag = JSON.parse(fs.readFileSync(path.join(reader, 'feature-flags/flag-x.json'), 'utf8'))
    expect(finalFlag.default.rules[0].value.value).to.equal(false)
  })

  it('cross-flag interleaving: chronological order across flags, not grouped by flag', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {fullName: 'Ada', email: 'ada@example.com'}

    const perChange = new Map<string, FakeChange>([
      ['flag-x@1000', {key: 'flag-x', changedAt: 1000, changedBy: ada, summary: 'create flag-x', value: false}],
      ['flag-x@3000', {key: 'flag-x', changedAt: 3000, changedBy: ada, summary: 'flip flag-x', value: true}],
      ['flag-y@2000', {key: 'flag-y', changedAt: 2000, changedBy: ada, summary: 'create flag-y', value: true}],
    ])

    await pushMigrationToCloud({
      changes: [makeChange('flag-x', 1000), makeChange('flag-y', 2000), makeChange('flag-x', 3000)],
      environments: ['production'],
      fullHistory: true,
      importState: {lastProcessedAt: 3000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeAuditSource(perChange),
    })

    const reader = cloneForRead(remote, root)
    const log = readLog(reader)
    // initial + 3 audit + 1 state-file
    expect(log).to.have.length(5)
    expect(log.slice(0, 4).map((e) => e.subject)).to.deep.equal([
      'initial',
      'create flag-x',
      'create flag-y',
      'flip flag-x',
    ])
    expect(log[4].subject).to.match(/migrator/i)
  })

  it('empty summary falls back to a non-empty migrator-generated message', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {fullName: 'Ada', email: 'ada@example.com'}

    const perChange = new Map<string, FakeChange>([
      // summary intentionally omitted; source returns fallback `migrator: update flag-x`
      ['flag-x@1000', {key: 'flag-x', changedAt: 1000, changedBy: ada, value: true}],
    ])

    await pushMigrationToCloud({
      changes: [makeChange('flag-x', 1000)],
      environments: ['production'],
      fullHistory: true,
      importState: {lastProcessedAt: 1000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeAuditSource(perChange),
    })

    const reader = cloneForRead(remote, root)
    const log = readLog(reader)
    // initial + 1 audit + 1 state-file
    expect(log).to.have.length(3)
    expect(log[1].subject).to.not.equal('')
    expect(log[1].subject.length).to.be.greaterThan(0)
  })

  it('same-millisecond changes preserve input order (deterministic tie-break)', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {fullName: 'Ada', email: 'ada@example.com'}

    // Two changes at the exact same timestamp — input order from the caller
    // must determine commit order. Distinct keys so they don't collide.
    const perChange = new Map<string, FakeChange>([
      ['flag-a@5000', {key: 'flag-a', changedAt: 5000, changedBy: ada, summary: 'first input', value: true}],
      ['flag-b@5000', {key: 'flag-b', changedAt: 5000, changedBy: ada, summary: 'second input', value: true}],
    ])

    await pushMigrationToCloud({
      changes: [makeChange('flag-a', 5000), makeChange('flag-b', 5000)],
      environments: ['production'],
      fullHistory: true,
      importState: {lastProcessedAt: 5000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeAuditSource(perChange),
    })

    const reader = cloneForRead(remote, root)
    const log = readLog(reader)
    const auditSubjects = log.slice(1, 3).map((e) => e.subject)
    expect(auditSubjects).to.deep.equal(['first input', 'second input'])
  })

  it('state-file changes land only in the final commit, never interleaved into audit commits', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {fullName: 'Ada', email: 'ada@example.com'}
    const perChange = new Map<string, FakeChange>([
      ['flag-x@1000', {key: 'flag-x', changedAt: 1000, changedBy: ada, summary: 'msg-1', value: false}],
      ['flag-x@2000', {key: 'flag-x', changedAt: 2000, changedBy: ada, summary: 'msg-2', value: true}],
    ])

    await pushMigrationToCloud({
      changes: [makeChange('flag-x', 1000), makeChange('flag-x', 2000)],
      environments: ['production'],
      fullHistory: true,
      importState: {lastProcessedAt: 2000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeAuditSource(perChange),
    })

    const reader = cloneForRead(remote, root)
    const log = readLog(reader)
    // initial + 2 audit + 1 state-file
    expect(log).to.have.length(4)
    // Audit commits touch ONLY feature-flag files
    for (const audit of [log[1], log[2]]) {
      expect(audit.changedPaths).to.deep.equal(['feature-flags/flag-x.json'])
    }

    // Final commit touches state files and the migration report only
    const finalPaths = new Set(log[3].changedPaths)
    expect(finalPaths.has('.qf/import-state.json')).to.equal(true)
    expect(finalPaths.has('.qf/MIGRATION_REPORT.md')).to.equal(true)
    expect(finalPaths.has('feature-flags/flag-x.json')).to.equal(false)
  })

  it('default off: same setup without --full-summary still collapses to one commit with migrator identity', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {fullName: 'Ada', email: 'ada@example.com'}
    const perChange = new Map<string, FakeChange>([
      ['flag-x@1000', {key: 'flag-x', changedAt: 1000, changedBy: ada, summary: 'create', value: false}],
      ['flag-x@2000', {key: 'flag-x', changedAt: 2000, changedBy: ada, summary: 'flip', value: true}],
    ])

    await pushMigrationToCloud({
      changes: [makeChange('flag-x', 1000), makeChange('flag-x', 2000)],
      environments: ['production'],
      // fullHistory NOT set
      importState: {lastProcessedAt: 2000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeAuditSource(perChange),
    })

    const reader = cloneForRead(remote, root)
    const log = readLog(reader)
    // initial + 1 collapsed commit
    expect(log).to.have.length(2)
    expect(log[1].authorEmail).to.equal('migrator@quonfig.com')

    const finalFlag = JSON.parse(fs.readFileSync(path.join(reader, 'feature-flags/flag-x.json'), 'utf8'))
    expect(finalFlag.default.rules[0].value.value).to.equal(true)
  })

  it('cross-type duplicate keys (same key as config AND feature_flag) are resolved in the final commit', async () => {
    // qfg-wbkj follow-up: writeQuonfigFiles runs per-change in audit mode and
    // cannot see cross-change collisions. The final commit must run
    // detectDuplicateKeys over the cumulative tree (config wins) so
    // validateWorkspace doesn't reject the push.
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const ada = {email: 'ada@example.com', name: 'Ada'}

    const dualSource: MigrationSource = {
      async *fetchChanges() {
        /* not used */
      },
      getCommitMeta(change: LegacyChange): CommitMeta {
        return {author: ada, date: change.changedAt!, message: `change ${change.key}@${change.changedAt}`}
      },
      async listEnvironments() {
        return []
      },
      name: 'fake',
      translate(change: LegacyChange): QuonfigFile[] {
        // The change.raw.type discriminator routes to flag vs config output.
        const type = (change.raw as {type: string}).type
        const dir = type === 'config' ? 'configs' : 'feature-flags'
        const body = type === 'config' ? validConfig(change.key!, true) : validFeatureFlag(change.key!, true)
        return [{contents: body, path: `${dir}/${change.key}.json`}]
      },
      async validateAuth() {
        /* noop */
      },
    }

    const flagChange: LegacyChange = {changedAt: 1000, key: 'collide', raw: {type: 'feature_flag'}, source: 'fake'}
    const configChange: LegacyChange = {changedAt: 2000, key: 'collide', raw: {type: 'config'}, source: 'fake'}

    await pushMigrationToCloud({
      changes: [flagChange, configChange],
      environments: ['production'],
      fullHistory: true,
      importState: {lastProcessedAt: 2000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: dualSource,
    })

    const reader = cloneForRead(remote, root)
    // Config kept, flag deleted.
    expect(fs.existsSync(path.join(reader, 'configs/collide.json'))).to.equal(true)
    expect(fs.existsSync(path.join(reader, 'feature-flags/collide.json'))).to.equal(false)

    const log = readLog(reader)
    // initial + flag-create + config-create + final state-file commit
    expect(log).to.have.length(4)

    // The deletion of feature-flags/collide.json happens in the final commit,
    // not in an audit commit — it's migrator-attributed bookkeeping.
    const finalPaths = new Set(log[3].changedPaths)
    expect(finalPaths.has('feature-flags/collide.json')).to.equal(true)
    expect(log[3].authorEmail).to.equal('migrator@quonfig.com')
  })
})
