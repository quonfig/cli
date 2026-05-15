/**
 * Generate the canonical `expected/` Quonfig outputs for the LaunchDarkly
 * fixture corpus (plan §6.1 step 2).
 *
 * For every raw `fx-*.json` fixture under
 * `test/migrate/fixtures/launchdarkly/raw/`, this runs the converter
 * (`translateFlag` / `translateSegment`) and writes the resulting QuonfigFile
 * JSON to `test/migrate/fixtures/launchdarkly/expected/<fixture>.json`.
 *
 * Those `expected/` files are the *contract* the golden test
 * (`launchdarkly-golden.test.ts`) deep-equals against: a converter change that
 * alters any mapping shows up as a diff in the corresponding expected file and
 * fails the golden test loudly. So this script is run intentionally — when the
 * converter's output is *meant* to change — never as part of the test run.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/generate-ld-expected.ts
 *
 * Output is deterministic (the converter sorts environments; JSON is
 * 2-space-indented with a trailing newline) so a regen produces a clean diff.
 */

import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  segmentOutputPath,
  translateFlag,
  translateSegment,
} from '../src/migrate/sources/launchdarkly/translate.js'
import type {LDFlag, LDSegment} from '../src/migrate/sources/launchdarkly/types.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'migrate', 'fixtures', 'launchdarkly')
const RAW_DIR = join(FIXTURE_DIR, 'raw')
const EXPECTED_DIR = join(FIXTURE_DIR, 'expected')

/** A flag carries a `variations` array; a segment never does. */
function isFlag(raw: unknown): raw is LDFlag {
  return typeof raw === 'object' && raw !== null && Array.isArray((raw as {variations?: unknown}).variations)
}

function main(): void {
  if (!existsSync(RAW_DIR)) {
    throw new Error(`raw fixture corpus not found at ${RAW_DIR}`)
  }

  mkdirSync(EXPECTED_DIR, {recursive: true})

  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as unknown
    const report = new ConversionReport()

    const converted = isFlag(raw)
      ? {outputPath: flagOutputPath(raw.key), quonfig: translateFlag(raw, report)}
      : {outputPath: segmentOutputPath((raw as LDSegment).key), quonfig: translateSegment(raw as LDSegment, report)}

    writeFileSync(join(EXPECTED_DIR, file), JSON.stringify(converted.quonfig, null, 2) + '\n', 'utf8')
  }

  console.log(`Wrote ${files.length} expected outputs to ${EXPECTED_DIR}`)
}

main()
