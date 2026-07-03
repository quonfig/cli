import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {readKeyPlan, writeKeyPlan} from '../../src/migrate/import-state.js'
import {
  getFullKeyPlan,
  planKeyRewritesForChanges,
  resetKeyRewriter,
  resolveKey,
} from '../../src/migrate/key-rewriter.js'
import {applyLocalMigration} from '../../src/migrate/local-write.js'
import {pushMigrationToCloud} from '../../src/migrate/push-to-cloud.js'
import type {LegacyChange, MigrationSource} from '../../src/migrate/source.js'

// Delta-run key-plan persistence: a full run plans finals over the COMPLETE
// key set, but a later incremental run (since-cursor is the default on dir
// reuse; --recent slices every source) replans over the SUBSET it fetched. A
// key that resolved to 'my-flag-2' in the full run (because 'my-flag' also
// existed) would replan to 'my-flag' in a delta run that only contains it —
// silently overwriting a DIFFERENT flag's file. The complete source->final
// map (including unchanged keys) is therefore persisted to .qf/key-plan.json
// and is authoritative on every subsequent run.

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

/** A verify-clean feature flag whose default string value doubles as a marker. */
function flagJson(key: string, marker: string): string {
  return (
    JSON.stringify(
      {
        default: {
          rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: marker}}],
        },
        environments: [],
        key,
        type: 'feature_flag',
        valueType: 'string',
        variants: [],
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * Fake source that mirrors the real ones: translate() resolves the source key
 * through the run-level rewriter and emits `feature-flags/<final>.json`. The
 * change's `raw.marker` lands in the flag so tests can tell WHICH source key's
 * content ended up in each file.
 */
function makeRewritingSource(): MigrationSource {
  return {
    async *fetchChanges() {
      // Not used; callers feed `changes` directly into the write paths.
    },
    async listEnvironments() {
      return ['production']
    },
    name: 'fake',
    translate(change) {
      const final = resolveKey(change.key ?? '')
      const marker = (change.raw as {marker?: string}).marker ?? ''
      return [{contents: flagJson(final, marker), path: `feature-flags/${final}.json`}]
    },
    async validateAuth() {
      /* noop */
    },
  }
}

function makeChange(key: string, changedAt: number, marker: string): LegacyChange {
  return {changedAt, key, raw: {marker}, source: 'fake'}
}

function emptyReport(source = 'fake'): Parameters<typeof applyLocalMigration>[0]['reportData'] {
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
    source,
    unsupportedFeatures: [],
  }
}

function readFlagMarker(dir: string, final: string): {key: string; marker: string} {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'feature-flags', `${final}.json`), 'utf8')) as {
    default: {rules: Array<{value: {value: string}}>}
    key: string
  }
  return {key: parsed.key, marker: parsed.default.rules[0].value.value}
}

describe('persisted key plan (delta-run consistency)', () => {
  afterEach(() => resetKeyRewriter())

  describe('key-rewriter persisted-plan semantics', () => {
    it('getFullKeyPlan returns source->final for EVERY planned key, including unchanged ones', () => {
      planKeyRewritesForChanges([{key: 'my flag'}, {key: 'my-flag'}])
      expect(getFullKeyPlan()).to.deep.equal({'my flag': 'my-flag-2', 'my-flag': 'my-flag'})
    })

    it('a delta run seeded with the persisted plan resolves previously-mapped keys identically', () => {
      planKeyRewritesForChanges([{key: 'my flag'}, {key: 'my-flag'}])
      const plan = getFullKeyPlan()

      // Delta run: only 'my flag' was fetched. Without the persisted plan it
      // would replan to 'my-flag' and clobber the other flag's file.
      planKeyRewritesForChanges([{key: 'my flag'}], plan)
      expect(resolveKey('my flag')).to.equal('my-flag-2')
    })

    it('seeds takenLower with ALL persisted finals so new keys cannot claim them', () => {
      const plan = {'my flag': 'my-flag-2', 'my-flag': 'my-flag'}
      // 'my+flag' is brand new and sanitizes to 'my-flag' — both that and
      // 'my-flag-2' are owned by persisted keys, so it must skip to -3.
      planKeyRewritesForChanges([{key: 'my+flag'}], plan)
      expect(resolveKey('my+flag')).to.equal('my-flag-3')
    })

    it('a NEW valid key cannot steal a final persisted for a different source key', () => {
      // The full run mapped 'my flag' -> 'my-flag' (no conflict existed then).
      // A later delta introduces the VALID source key 'my-flag'; the persisted
      // owner keeps the name — otherwise the new key overwrites its file.
      const plan = {'my flag': 'my-flag'}
      planKeyRewritesForChanges([{key: 'my flag'}, {key: 'my-flag'}], plan)
      expect(resolveKey('my flag')).to.equal('my-flag')
      expect(resolveKey('my-flag')).to.equal('my-flag-2')
    })

    it('resolveKey falls back to the persisted final for keys not in the current change set', () => {
      // A delta run's flag may reference a segment that was migrated in the
      // full run but is absent from the delta's change set. The reference must
      // still resolve to the persisted final, not a fresh sanitize.
      const plan = {'Beta Users': 'Beta-Users-2', 'Beta-Users': 'Beta-Users'}
      planKeyRewritesForChanges([{key: 'some.flag'}], plan)
      expect(resolveKey('Beta Users')).to.equal('Beta-Users-2')
    })

    it('getFullKeyPlan merges persisted entries with newly planned ones', () => {
      const plan = {'my flag': 'my-flag-2', 'my-flag': 'my-flag'}
      planKeyRewritesForChanges([{key: 'other key'}], plan)
      expect(getFullKeyPlan()).to.deep.equal({
        'my flag': 'my-flag-2',
        'my-flag': 'my-flag',
        'other key': 'other-key',
      })
    })
  })

  describe('.qf/key-plan.json read/write', () => {
    let tmpdir: string

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-plan-'))
    })

    afterEach(() => {
      fs.rmSync(tmpdir, {force: true, recursive: true})
    })

    it('round-trips the complete mapping', () => {
      writeKeyPlan(tmpdir, {'my flag': 'my-flag-2', 'my-flag': 'my-flag'})
      expect(readKeyPlan(tmpdir)).to.deep.equal({'my flag': 'my-flag-2', 'my-flag': 'my-flag'})
      const raw = JSON.parse(fs.readFileSync(path.join(tmpdir, '.qf', 'key-plan.json'), 'utf8'))
      expect(raw.version).to.equal(1)
    })

    it('returns null when the file is missing or malformed', () => {
      expect(readKeyPlan(tmpdir)).to.equal(null)
      fs.mkdirSync(path.join(tmpdir, '.qf'), {recursive: true})
      fs.writeFileSync(path.join(tmpdir, '.qf', 'key-plan.json'), 'not json', 'utf8')
      expect(readKeyPlan(tmpdir)).to.equal(null)
      fs.writeFileSync(path.join(tmpdir, '.qf', 'key-plan.json'), '{"version":1,"keys":"nope"}', 'utf8')
      expect(readKeyPlan(tmpdir)).to.equal(null)
    })
  })

  describe('applyLocalMigration (local write path)', () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-plan-local-'))
    })

    afterEach(() => {
      fs.rmSync(root, {force: true, recursive: true})
    })

    it('a delta run reuses the full run’s persisted mapping instead of replanning the subset', async () => {
      const dir = path.join(root, 'workspace')
      const source = makeRewritingSource()

      // Full run: 'my flag' (sanitizes to 'my-flag', suffixed to 'my-flag-2'
      // because the valid 'my-flag' claims its own name) + 'my-flag'.
      await applyLocalMigration({
        changes: [makeChange('my flag', 1000, 'A1'), makeChange('my-flag', 2000, 'B1')],
        environments: ['production'],
        importState: {lastProcessedAt: 2000, source: 'fake'},
        localDir: dir,
        reportData: emptyReport(),
        source,
      })

      expect(readFlagMarker(dir, 'my-flag')).to.deep.equal({key: 'my-flag', marker: 'B1'})
      expect(readFlagMarker(dir, 'my-flag-2')).to.deep.equal({key: 'my-flag-2', marker: 'A1'})
      // The COMPLETE plan (unchanged keys included) is persisted.
      expect(readKeyPlan(dir)).to.deep.equal({'my flag': 'my-flag-2', 'my-flag': 'my-flag'})

      // Delta run: only 'my flag' changed since the cursor. It must still
      // resolve to 'my-flag-2' — NEVER 'my-flag' (someone else's file).
      await applyLocalMigration({
        changes: [makeChange('my flag', 3000, 'A2')],
        environments: ['production'],
        importState: {lastProcessedAt: 3000, source: 'fake'},
        localDir: dir,
        reportData: emptyReport(),
        source,
      })

      expect(readFlagMarker(dir, 'my-flag-2')).to.deep.equal({key: 'my-flag-2', marker: 'A2'})
      // The other flag's file is untouched.
      expect(readFlagMarker(dir, 'my-flag')).to.deep.equal({key: 'my-flag', marker: 'B1'})
      expect(readKeyPlan(dir)).to.deep.equal({'my flag': 'my-flag-2', 'my-flag': 'my-flag'})
    })
  })

  describe('pushMigrationToCloud (clone-and-stack push path)', () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-plan-push-'))
    })

    afterEach(() => {
      fs.rmSync(root, {force: true, recursive: true})
    })

    it('a delta push into a FRESH clone honors the key plan committed to the workspace repo', async () => {
      const remote = createBareRemote(root)
      seedRemote(remote, root)
      const source = makeRewritingSource()

      // Full run pushes both flags + the key plan to the workspace repo.
      await pushMigrationToCloud({
        changes: [makeChange('my flag', 1000, 'A1'), makeChange('my-flag', 2000, 'B1')],
        environments: ['production'],
        importState: {lastProcessedAt: 2000, source: 'fake'},
        localDir: path.join(root, 'workspace-1'),
        remoteUrl: remote,
        reportData: emptyReport(),
        source,
      })

      // Delta run from a DIFFERENT machine/dir (fresh clone), e.g. --recent 1:
      // only 'my flag' is in the change set. The plan comes down with the
      // clone and must be honored.
      await pushMigrationToCloud({
        changes: [makeChange('my flag', 3000, 'A2')],
        environments: ['production'],
        importState: {lastProcessedAt: 3000, source: 'fake'},
        localDir: path.join(root, 'workspace-2'),
        remoteUrl: remote,
        reportData: emptyReport(),
        source,
      })

      const reader = cloneForRead(remote, root)
      expect(readFlagMarker(reader, 'my-flag-2')).to.deep.equal({key: 'my-flag-2', marker: 'A2'})
      expect(readFlagMarker(reader, 'my-flag')).to.deep.equal({key: 'my-flag', marker: 'B1'})
      expect(readKeyPlan(reader)).to.deep.equal({'my flag': 'my-flag-2', 'my-flag': 'my-flag'})
    })
  })
})
