import {expect} from 'chai'
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  segmentOutputPath,
  translateFeature,
  translateSegment,
} from '../../src/migrate/sources/flagsmith/translate.js'
import type {
  FlagsmithFeatureWithStates,
  FlagsmithSegment,
  FlagsmithTag,
} from '../../src/migrate/sources/flagsmith/types.js'

/**
 * The Flagsmith converter golden tests (plan §6.1 step 3).
 *
 * For every raw `fx-*.json` fixture in the canonical corpus there is a
 * hand-reviewed `expected/<fixture>/<output-path>.json` — the exact
 * QuonfigFile the converter must produce. This suite is table-driven: one
 * `it()` per fixture, asserting `translate(raw)` deep-equals `expected`.
 *
 * The `expected/` files are the *contract*: they were produced by
 * `scripts/generate-flagsmith-expected.ts` and then reviewed. A converter
 * change that alters any mapping — a new operator, a different rule shape,
 * a metadata field gained or lost — fails the matching case here with a
 * structural diff. When a change to the converter's output is intentional,
 * re-run the generator script and commit the per-fixture diff alongside the
 * converter change.
 *
 * This is the structural half of plan §6; `flagsmith-roundtrip.test.ts`
 * covers the semantic half (evaluate the converted output with sdk-node).
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'flagsmith')
const RAW_DIR = join(FIXTURE_DIR, 'raw')
const EXPECTED_DIR = join(FIXTURE_DIR, 'expected')

/**
 * Matrix rows whose raw fixture is fully ABSENT from the live `Test1` corpus.
 * CORPUS.md tracks 9 "gaps" total but 5 of those are change-request gaps where
 * the underlying feature DID get created (fx-cr-*); only the change-request
 * attached to it is paywalled. Those features have raw fixtures and roll
 * through the golden suite like any other — they just exercise the no-CR
 * branch of the converter. The 4 listed here are the truly-absent ones:
 * the generator could not produce ANY fixture for these matrix rows.
 */
const KNOWN_GAPS = [
  // segments with `rules:[]` are rejected by the API at create time.
  'fx-seg-zero-rules',
  // soft-deleted feature is never readable via the public API.
  'fx-edge-soft-deleted-feature',
  // scheduled versions live behind the Scale-up plan.
  'fx-ver-scheduled',
  // project-level metadata fields aren't configured on Test1.
  'fx-meta-feature-metadata',
]

interface SnapshotMeta {
  envNameByApiKey: Record<string, string>
  segmentNameById: Record<string, string>
  tags: FlagsmithTag[]
}

function loadMeta(): SnapshotMeta {
  return JSON.parse(readFileSync(join(RAW_DIR, '_snapshot-meta.json'), 'utf8')) as SnapshotMeta
}

/** A feature bundle carries `featurestates_by_env`; a segment does not. */
function isFeatureBundle(raw: unknown): raw is FlagsmithFeatureWithStates {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'feature' in raw &&
    'featurestates_by_env' in raw &&
    typeof (raw as {featurestates_by_env: unknown}).featurestates_by_env === 'object'
  )
}

function listFixtureFiles(): string[] {
  if (!existsSync(RAW_DIR)) return []
  return readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
}

function listExpectedFixtures(): string[] {
  if (!existsSync(EXPECTED_DIR)) return []
  return readdirSync(EXPECTED_DIR)
    .filter((name) => {
      const full = join(EXPECTED_DIR, name)
      return statSync(full).isDirectory()
    })
    .sort()
}

describe('migrate/sources/flagsmith — converter golden tests', () => {
  const files = listFixtureFiles()
  const meta = existsSync(join(RAW_DIR, '_snapshot-meta.json')) ? loadMeta() : null

  it('has a non-empty raw corpus', () => {
    expect(files.length, 'raw corpus is empty — did the corpus get wiped?').to.be.greaterThan(0)
  })

  it('has an expected/ subdir for every raw fixture (no orphans either way)', () => {
    const rawKeys = files.map((f) => f.replace(/\.json$/, '')).sort()
    const expectedKeys = listExpectedFixtures()
    expect(
      expectedKeys,
      `${EXPECTED_DIR} must mirror raw/ exactly — run scripts/generate-flagsmith-expected.ts`,
    ).to.deep.equal(rawKeys)
  })

  it(`KNOWN_GAPS lists exactly ${KNOWN_GAPS.length} fully-absent fixtures`, () => {
    expect(KNOWN_GAPS).to.have.lengthOf(4)
    // Defensive: none of the gapped names should appear in the corpus on disk.
    const present = new Set(files.map((f) => f.replace(/\.json$/, '')))
    for (const gap of KNOWN_GAPS) {
      expect(present.has(gap), `KNOWN_GAPS entry ${gap} unexpectedly present in raw/`).to.equal(false)
    }
  })

  for (const file of files) {
    const fixture = file.replace(/\.json$/, '')

    it(`converts ${file} to its golden expected/ output`, () => {
      expect(meta, '_snapshot-meta.json must exist alongside raw/ fixtures').to.not.equal(null)
      const envNameByApiKey = new Map(Object.entries(meta!.envNameByApiKey))
      const segmentNameById = new Map(Object.entries(meta!.segmentNameById).map(([k, v]) => [Number(k), v]))

      const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as unknown
      const report = new ConversionReport()

      let actual: unknown
      let outputPath: string
      if (isFeatureBundle(raw)) {
        actual = translateFeature(raw, report, {envNameByApiKey, segmentNameById, tags: meta!.tags})
        outputPath = flagOutputPath(raw.feature.name)
      } else {
        const seg = raw as FlagsmithSegment
        actual = translateSegment(seg, report)
        outputPath = segmentOutputPath(seg.name)
      }

      const expectedPath = join(EXPECTED_DIR, fixture, outputPath)
      expect(
        existsSync(expectedPath),
        `missing golden file ${expectedPath} — run scripts/generate-flagsmith-expected.ts`,
      ).to.equal(true)
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as unknown

      expect(actual, `converter output for ${file} drifted from its golden expected/ output`).to.deep.equal(expected)
    })

    it(`emits the canonical output path for ${file}`, () => {
      const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as unknown
      const path = isFeatureBundle(raw)
        ? flagOutputPath(raw.feature.name)
        : segmentOutputPath((raw as FlagsmithSegment).name)
      const expectedPrefix = isFeatureBundle(raw) ? 'feature-flags/' : 'segments/'
      expect(path).to.match(new RegExp(`^${expectedPrefix}[^/]+\\.json$`))
    })
  }
})
