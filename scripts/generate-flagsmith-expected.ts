/**
 * Generate the canonical `expected/` Quonfig outputs for the Flagsmith fixture
 * corpus (plan §6.1 step 2).
 *
 * For every raw `fx-*.json` fixture under
 * `test/migrate/fixtures/flagsmith/raw/`, this runs the converter
 * (`translateFeature` / `translateSegment`) and writes the resulting QuonfigFile
 * JSON to `test/migrate/fixtures/flagsmith/expected/<fixture>/<output-path>`.
 *
 * Features land under `expected/<fixture>/feature-flags/<key>.json`; segments
 * under `expected/<fixture>/segments/<key>.json` — mirroring the Quonfig
 * datadir layout exactly. The converter is deterministic so a regen produces a
 * clean per-fixture diff when the converter's output is intentionally changed.
 *
 * The script also reports `coerced: N` per fixture when the converter records
 * `enabled-false-non-boolean` or `cross-env-value-type-coerced` notes — useful
 * for review-by-glance during operator/D-F1 changes.
 *
 * The env-name + segment-name + tag maps come from `raw/_snapshot-meta.json`,
 * so this script needs no live account access.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/generate-flagsmith-expected.ts
 */

import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  segmentOutputPath,
  translateFeature,
  translateSegment,
} from '../src/migrate/sources/flagsmith/translate.js'
import type {
  FlagsmithFeatureWithStates,
  FlagsmithSegment,
  FlagsmithTag,
} from '../src/migrate/sources/flagsmith/types.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'migrate', 'fixtures', 'flagsmith')
const RAW_DIR = join(FIXTURE_DIR, 'raw')
const EXPECTED_DIR = join(FIXTURE_DIR, 'expected')

interface SnapshotMeta {
  envNameByApiKey: Record<string, string>
  projectId: number
  projectName: string
  segmentNameById: Record<string, string>
  tags: FlagsmithTag[]
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

function loadMeta(): SnapshotMeta {
  const metaPath = join(RAW_DIR, '_snapshot-meta.json')
  if (!existsSync(metaPath)) {
    throw new Error(`missing ${metaPath} — run scripts/export-flagsmith-fixtures.ts (or restore the committed file)`)
  }

  return JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta
}

function main(): void {
  if (!existsSync(RAW_DIR)) {
    throw new Error(`raw fixture corpus not found at ${RAW_DIR}`)
  }

  const meta = loadMeta()
  const envNameByApiKey = new Map(Object.entries(meta.envNameByApiKey))
  const segmentNameById = new Map(Object.entries(meta.segmentNameById).map(([k, v]) => [Number(k), v]))
  const tags = meta.tags

  mkdirSync(EXPECTED_DIR, {recursive: true})

  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()

  for (const file of files) {
    const fixture = file.replace(/\.json$/, '')
    const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as unknown
    const report = new ConversionReport()

    let outputPath: string
    let quonfig: unknown
    if (isFeatureBundle(raw)) {
      quonfig = translateFeature(raw, report, {envNameByApiKey, segmentNameById, tags})
      outputPath = flagOutputPath(raw.feature.name)
    } else {
      const seg = raw as FlagsmithSegment
      quonfig = translateSegment(seg, report)
      outputPath = segmentOutputPath(seg.name)
    }

    const target = join(EXPECTED_DIR, fixture, outputPath)
    mkdirSync(dirname(target), {recursive: true})
    writeFileSync(target, JSON.stringify(quonfig, null, 2) + '\n', 'utf8')

    const coerced =
      report.byCategory('enabled-false-non-boolean').length + report.byCategory('cross-env-value-type-coerced').length
    const idov = report.byCategory('identity-override-as-rule').length
    const skipped = report.byCategory('skipped-rule').length
    const parts = [`1 file`]
    if (coerced > 0) parts.push(`${coerced} coerced`)
    if (idov > 0) parts.push(`${idov} idov-as-rule`)
    if (skipped > 0) parts.push(`${skipped} skipped-rule`)
    console.log(`generated ${fixture}: ${parts.join(', ')}`)
  }

  console.log(`Wrote ${files.length} expected fixtures to ${EXPECTED_DIR}`)
}

main()
