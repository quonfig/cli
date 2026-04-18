import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {LegacyChange, MigrationSource, QuonfigFile} from '../../src/migrate/source.js'

import {pushMigrationToCloud} from '../../src/migrate/push-to-cloud.js'

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

function addUiCommit(remoteDir: string, rootTmp: string, relPath: string, contents: string, message: string): void {
  const tmp = fs.mkdtempSync(path.join(rootTmp, 'ui-'))
  run(tmp, 'clone', remoteDir, '.')
  run(tmp, 'config', 'user.email', 'ui@test')
  run(tmp, 'config', 'user.name', 'UI Editor')
  const full = path.join(tmp, relPath)
  fs.mkdirSync(path.dirname(full), {recursive: true})
  fs.writeFileSync(full, contents)
  run(tmp, 'add', '.')
  run(tmp, 'commit', '-m', message)
  run(tmp, 'push', 'origin', 'main')
}

function cloneForRead(remoteDir: string, rootTmp: string): string {
  const tmp = fs.mkdtempSync(path.join(rootTmp, 'read-'))
  run(tmp, 'clone', remoteDir, '.')
  return tmp
}

function logSubjects(dir: string): string[] {
  return run(dir, 'log', '--pretty=format:%s').split('\n').filter(Boolean)
}

/** Fake source whose translate() round-trips per-change file outputs. */
function makeFakeSource(filesByKey: Map<string, QuonfigFile[]>): MigrationSource {
  return {
    async *fetchChanges() {
      // Not used; caller feeds `changes` directly into pushMigrationToCloud.
    },
    async listEnvironments() {
      return []
    },
    name: 'fake',
    translate(change) {
      return filesByKey.get(change.key ?? '') ?? []
    },
    async validateAuth() {
      /* noop */
    },
  }
}

function makeChange(key: string, changedAt: number): LegacyChange {
  return {changedAt, key, raw: {}, source: 'fake'}
}

function emptyReport(source = 'fake'): Parameters<typeof pushMigrationToCloud>[0]['reportData'] {
  return {
    cleanMappings: [],
    counts: {environmentsMapped: 0, flagsMigrated: 0, itemsSkipped: 0, segmentsMigrated: 0},
    dryRun: false,
    environmentMap: [],
    followUp: {mustFixBeforeCutover: [], reviewPostCutover: []},
    identifierMap: {},
    lossyMappings: [],
    source,
    unsupportedFeatures: [],
  }
}

describe('pushMigrationToCloud', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-to-cloud-'))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('first run: translates changes, writes files + MIGRATION_REPORT.md + .qf/import-state.json, and pushes delta commit', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    const filesByKey = new Map<string, QuonfigFile[]>([
      [
        'flag-a',
        [
          {
            contents: JSON.stringify({key: 'flag-a', rows: [{default: {value: true}}]}, null, 2),
            path: 'feature-flags/flag-a.json',
          },
        ],
      ],
      [
        'flag-b',
        [
          {
            contents: JSON.stringify({key: 'flag-b', rows: [{default: {value: 'hello'}}]}, null, 2),
            path: 'feature-flags/flag-b.json',
          },
        ],
      ],
    ])

    const result = await pushMigrationToCloud({
      changes: [makeChange('flag-a', 1000), makeChange('flag-b', 2000)],
      commitMessage: 'migrator: import 2 flags',
      importState: {lastProcessedAt: 2000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: {
        ...emptyReport(),
        cleanMappings: [
          {legacyKey: 'flag-a', quonfigKey: 'flag-a'},
          {legacyKey: 'flag-b', quonfigKey: 'flag-b'},
        ],
        counts: {environmentsMapped: 0, flagsMigrated: 2, itemsSkipped: 0, segmentsMigrated: 0},
      },
      source: makeFakeSource(filesByKey),
    })

    expect(result.committed).to.equal(true)
    expect(result.action).to.equal('cloned')

    const reader = cloneForRead(remote, root)
    expect(fs.existsSync(path.join(reader, 'feature-flags/flag-a.json'))).to.equal(true)
    expect(fs.existsSync(path.join(reader, 'feature-flags/flag-b.json'))).to.equal(true)

    const report = fs.readFileSync(path.join(reader, 'MIGRATION_REPORT.md'), 'utf8')
    expect(report).to.match(/Flags migrated: 2/)
    expect(report).to.match(/flag-a/)
    expect(report).to.match(/flag-b/)

    const state = JSON.parse(fs.readFileSync(path.join(reader, '.qf/import-state.json'), 'utf8'))
    expect(state.source).to.equal('fake')
    expect(state.lastProcessedAt).to.equal(2000)

    expect(logSubjects(reader)).to.deep.equal(['migrator: import 2 flags', 'initial'])
  })

  it('re-run stacks delta on top of a UI commit: flipped flag updated, new flag added, UI-edited flag untouched, linear history, MIGRATION_REPORT.md reflects only the delta', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    const localDir = path.join(root, 'workspace')

    // First run: import flag-a (v1) and flag-b (v1)
    await pushMigrationToCloud({
      changes: [makeChange('flag-a', 1000), makeChange('flag-b', 2000)],
      commitMessage: 'migrator: run 1',
      importState: {lastProcessedAt: 2000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: {
        ...emptyReport(),
        counts: {environmentsMapped: 0, flagsMigrated: 2, itemsSkipped: 0, segmentsMigrated: 0},
      },
      source: makeFakeSource(
        new Map([
          [
            'flag-a',
            [
              {
                contents: JSON.stringify({key: 'flag-a', value: 'v1'}, null, 2) + '\n',
                path: 'feature-flags/flag-a.json',
              },
            ],
          ],
          [
            'flag-b',
            [
              {
                contents: JSON.stringify({key: 'flag-b', value: 'v1'}, null, 2) + '\n',
                path: 'feature-flags/flag-b.json',
              },
            ],
          ],
        ]),
      ),
    })

    // Simulate UI edit: a human flips flag-b's value in the cloud UI (different file than what we'll touch on re-run)
    addUiCommit(
      remote,
      root,
      'feature-flags/flag-b.json',
      JSON.stringify({editedBy: 'ui', key: 'flag-b', value: 'UI-EDITED'}, null, 2) + '\n',
      'ui: flip flag-b',
    )

    // Re-run: flag-a is flipped in Launch (updated value) and flag-c is newly added.
    // flag-b is NOT re-exported — simulating that Launch did not change it and we only push the delta.
    const result = await pushMigrationToCloud({
      changes: [makeChange('flag-a', 3000), makeChange('flag-c', 4000)],
      commitMessage: 'migrator: run 2 delta',
      importState: {lastProcessedAt: 4000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: {
        ...emptyReport(),
        cleanMappings: [
          {legacyKey: 'flag-a', quonfigKey: 'flag-a'},
          {legacyKey: 'flag-c', quonfigKey: 'flag-c'},
        ],
        counts: {environmentsMapped: 0, flagsMigrated: 2, itemsSkipped: 0, segmentsMigrated: 0},
      },
      source: makeFakeSource(
        new Map([
          [
            'flag-a',
            [
              {
                contents: JSON.stringify({key: 'flag-a', value: 'v2-flipped'}, null, 2) + '\n',
                path: 'feature-flags/flag-a.json',
              },
            ],
          ],
          [
            'flag-c',
            [
              {
                contents: JSON.stringify({key: 'flag-c', value: 'brand-new'}, null, 2) + '\n',
                path: 'feature-flags/flag-c.json',
              },
            ],
          ],
        ]),
      ),
    })

    expect(result.committed).to.equal(true)
    expect(result.action).to.equal('reused')

    const reader = cloneForRead(remote, root)

    // Linear history: initial + run-1 + UI + run-2 (no force-push clobbered anything)
    expect(logSubjects(reader)).to.deep.equal([
      'migrator: run 2 delta',
      'ui: flip flag-b',
      'migrator: run 1',
      'initial',
    ])

    // flipped flag updated
    const flagA = JSON.parse(fs.readFileSync(path.join(reader, 'feature-flags/flag-a.json'), 'utf8'))
    expect(flagA.value).to.equal('v2-flipped')

    // new flag added
    const flagC = JSON.parse(fs.readFileSync(path.join(reader, 'feature-flags/flag-c.json'), 'utf8'))
    expect(flagC.value).to.equal('brand-new')

    // UI-edited flag untouched
    const flagB = JSON.parse(fs.readFileSync(path.join(reader, 'feature-flags/flag-b.json'), 'utf8'))
    expect(flagB.value).to.equal('UI-EDITED')
    expect(flagB.editedBy).to.equal('ui')

    // MIGRATION_REPORT.md reflects ONLY the delta of this run (flag-a + flag-c), not flag-b
    const report = fs.readFileSync(path.join(reader, 'MIGRATION_REPORT.md'), 'utf8')
    expect(report).to.match(/flag-a/)
    expect(report).to.match(/flag-c/)
    expect(report).to.not.match(/flag-b/)
    expect(report).to.match(/Reflects only the changes produced by this run/)

    // import-state.json cursor advanced
    const state = JSON.parse(fs.readFileSync(path.join(reader, '.qf/import-state.json'), 'utf8'))
    expect(state.lastProcessedAt).to.equal(4000)
  })

  it('strips .qf from .gitignore so state file is committed (re-run picks up cursor)', async () => {
    const remote = createBareRemote(root)
    seedRemote(remote, root)
    // Pre-seed .gitignore on the remote that ignores .qf/
    addUiCommit(remote, root, '.gitignore', '.qf/\nnode_modules/\n', 'chore: add gitignore')

    const localDir = path.join(root, 'workspace')

    await pushMigrationToCloud({
      changes: [makeChange('flag-a', 1000)],
      commitMessage: 'migrator: import',
      importState: {lastProcessedAt: 1000, source: 'fake'},
      localDir,
      remoteUrl: remote,
      reportData: emptyReport(),
      source: makeFakeSource(new Map([['flag-a', [{contents: '{"v":1}\n', path: 'feature-flags/flag-a.json'}]]])),
    })

    const reader = cloneForRead(remote, root)
    const gitignore = fs.readFileSync(path.join(reader, '.gitignore'), 'utf8')
    expect(gitignore).to.not.match(/\.qf\/?/)
    expect(gitignore).to.match(/node_modules/)
    // state file landed
    expect(fs.existsSync(path.join(reader, '.qf/import-state.json'))).to.equal(true)
  })
})
