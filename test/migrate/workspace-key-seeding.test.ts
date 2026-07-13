import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {readKeyPlan} from '../../src/migrate/import-state.js'
import {
  getKeyRewrites,
  planKeyRewritesForChanges,
  resetKeyRewriter,
  resolveKey,
} from '../../src/migrate/key-rewriter.js'
import {pushMigrationToCloud} from '../../src/migrate/push-to-cloud.js'
import type {LegacyChange, MigrationSource} from '../../src/migrate/source.js'

// qfg-hbuy.12: the key rewriter used to seed `takenLower` only from the IMPORT
// set, so importing `Foo` into a workspace that already had `foo` (created via
// the UI, or by an earlier tool that left no key plan) produced a
// case-insensitive collision the verify gate rejects — and the whole migration
// aborted. Push mode clones the live workspace, so the existing keys are right
// there on disk. Decided semantics:
//   - EXACT byte-equal match: keep today's behavior — silently overwrite;
//     that's the intentional re-migration/update path. Seeding must NOT cause
//     exact matches to be treated as taken and renamed.
//   - CASE-VARIANT match only: deterministically rename the incoming key via
//     the existing suffix machinery and surface it in the report. Never abort.
//   - The persisted key plan stays authoritative; workspace seeding only fills
//     in what the plan doesn't cover.

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function createBareRemote(rootTmp: string): string {
  const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
  run(remoteDir, 'init', '--bare', '--initial-branch=main')
  return remoteDir
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

/** Seed the remote like a UI user would: flag files, quonfig.json, NO .qf/key-plan.json. */
function seedRemoteWithFlags(remoteDir: string, rootTmp: string, flags: Array<{key: string; marker: string}>): void {
  const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
  run(seed, 'init', '--initial-branch=main')
  run(seed, 'config', 'user.email', 'ui@test')
  run(seed, 'config', 'user.name', 'UI Editor')
  fs.writeFileSync(path.join(seed, 'quonfig.json'), JSON.stringify({environments: ['production']}, null, 2) + '\n')
  fs.mkdirSync(path.join(seed, 'feature-flags'), {recursive: true})
  for (const flag of flags) {
    fs.writeFileSync(path.join(seed, 'feature-flags', `${flag.key}.json`), flagJson(flag.key, flag.marker))
  }

  run(seed, 'add', '.')
  run(seed, 'commit', '-m', 'ui: existing workspace flags')
  run(seed, 'remote', 'add', 'origin', remoteDir)
  run(seed, 'push', 'origin', 'main')
}

function cloneForRead(remoteDir: string, rootTmp: string): string {
  const tmp = fs.mkdtempSync(path.join(rootTmp, 'read-'))
  run(tmp, 'clone', remoteDir, '.')
  return tmp
}

/** Fake source mirroring the real ones: translate() resolves through the rewriter. */
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

function emptyReport(source = 'fake'): Parameters<typeof pushMigrationToCloud>[0]['reportData'] {
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

describe('existing-workspace key seeding (qfg-hbuy.12)', () => {
  afterEach(() => resetKeyRewriter())

  describe('rewriter seeding semantics', () => {
    it('an EXACT byte-equal existing key is NOT treated as taken — the re-migration overwrite path', () => {
      planKeyRewritesForChanges([{key: 'foo'}], undefined, ['foo'])
      expect(resolveKey('foo')).to.equal('foo')
      // No rewrite reported: nothing changed.
      expect(getKeyRewrites()).to.deep.equal([])
    })

    it('a CASE-VARIANT existing key forces a deterministic rename, surfaced in the report', () => {
      planKeyRewritesForChanges([{key: 'Foo'}], undefined, ['foo'])
      expect(resolveKey('Foo')).to.equal('Foo-2')
      const rewrites = getKeyRewrites()
      expect(rewrites.map((r) => `${r.source}=>${r.final}`)).to.deep.equal(['Foo=>Foo-2'])
      // The reason names the existing workspace key so the report is actionable.
      expect(rewrites[0].reasons.join(' ')).to.include('"foo"')
    })

    it('suffix candidates skip existing keys entirely — a RENAMED key never clobbers an unrelated one', () => {
      // 'Foo' is blocked by case-variant 'foo'; the suffix machinery must not
      // land on 'Foo-2' either, even though it byte-equals an existing key —
      // exact-match overwrite is only for a key claiming its OWN name.
      planKeyRewritesForChanges([{key: 'Foo'}], undefined, ['foo', 'Foo-2'])
      expect(resolveKey('Foo')).to.equal('Foo-3')
    })

    it('a sanitized key whose base byte-equals an existing key keeps overwriting it (re-migration path)', () => {
      planKeyRewritesForChanges([{key: 'my flag'}], undefined, ['my-flag'])
      expect(resolveKey('my flag')).to.equal('my-flag')
    })

    it('persisted key-plan mappings stay authoritative over workspace seeding', () => {
      planKeyRewritesForChanges([{key: 'my flag'}], {keys: {'my flag': 'my-flag'}, segmentKeys: {}}, ['My-Flag'])
      expect(resolveKey('my flag')).to.equal('my-flag')
    })

    it('two incoming keys: the exact match claims its name, then blocks the case-variant', () => {
      planKeyRewritesForChanges([{key: 'Foo'}, {key: 'foo'}], undefined, ['foo'])
      // 'Foo' sorts first but 'foo' is the byte-equal owner of the existing
      // key; the case-variant is the one renamed.
      expect(resolveKey('foo')).to.equal('foo')
      expect(resolveKey('Foo')).to.equal('Foo-2')
    })
  })

  describe('pushMigrationToCloud (fresh clone of a live workspace, no key plan)', () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-seed-push-'))
    })

    afterEach(() => {
      fs.rmSync(root, {force: true, recursive: true})
    })

    it('case-variant incoming keys are renamed, exact matches overwrite, and the push never aborts', async () => {
      const remote = createBareRemote(root)
      seedRemoteWithFlags(remote, root, [
        {key: 'foo', marker: 'EXISTING-FOO'},
        {key: 'bar', marker: 'EXISTING-BAR'},
      ])

      const result = await pushMigrationToCloud({
        changes: [
          // Case-variant of the existing 'foo' -> must be renamed, not abort.
          makeChange('Foo', 1000, 'NEW-FOO'),
          // Exact match of the existing 'bar' -> intentional overwrite.
          makeChange('bar', 2000, 'NEW-BAR'),
        ],
        environments: ['production'],
        importState: {lastProcessedAt: 2000, source: 'fake'},
        localDir: path.join(root, 'workspace'),
        remoteUrl: remote,
        reportData: emptyReport(),
        source: makeRewritingSource(),
      })

      expect(result.committed).to.equal(true)

      const reader = cloneForRead(remote, root)
      // Exact match: silently overwritten (the re-migration/update path).
      expect(readFlagMarker(reader, 'bar')).to.deep.equal({key: 'bar', marker: 'NEW-BAR'})
      // Case-variant: existing file untouched, incoming renamed deterministically.
      expect(readFlagMarker(reader, 'foo')).to.deep.equal({key: 'foo', marker: 'EXISTING-FOO'})
      expect(readFlagMarker(reader, 'Foo-2')).to.deep.equal({key: 'Foo-2', marker: 'NEW-FOO'})
      // Exact directory listing (existsSync would case-fold on macOS/Windows):
      // no bare Foo.json was written.
      expect(fs.readdirSync(path.join(reader, 'feature-flags')).sort()).to.deep.equal([
        'Foo-2.json',
        'bar.json',
        'foo.json',
      ])
      // The rename persists in the key plan so delta runs stay stable.
      expect(readKeyPlan(reader)).to.deep.equal({keys: {Foo: 'Foo-2', bar: 'bar'}, segmentKeys: {}})
    })
  })
})
