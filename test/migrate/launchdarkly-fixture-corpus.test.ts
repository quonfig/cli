import {expect} from 'chai'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  segmentOutputPath,
  translateFlag,
  translateSegment,
} from '../../src/migrate/sources/launchdarkly/translate.js'
import type {LDFlag, LDSegment} from '../../src/migrate/sources/launchdarkly/types.js'
import {validateFileMap} from '../../src/verify/validate.js'

/**
 * The canonical LaunchDarkly fixture corpus — raw Phase-1 JSON exported from the
 * live `competitor-launchdarkly` account (see `scripts/export-ld-fixtures.ts` and
 * the corpus's own `CORPUS.md`). This is the contract the converter golden tests
 * (plan §6.1) build against, so two things must hold and stay holding:
 *
 *   1. The corpus is present and substantial — a deleted or truncated corpus is
 *      a regression, not a passing test.
 *   2. Every raw fixture still converts: `translateFlag` / `translateSegment`
 *      must turn it into a `QuonfigFile` that `validateFileMap` accepts with zero
 *      errors. A converter change that breaks any fixture fails here loudly.
 */

const RAW_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'launchdarkly', 'raw')

/**
 * Floor on corpus size. The FIXTURE_MATRIX provisions ~84 flags + ~12 segments
 * in the live account; this guards against an accidental wipe without being so
 * tight that adding/removing a single fixture breaks the suite.
 */
const MIN_CORPUS_SIZE = 90

interface SnapshotMeta {
  environments: string[]
}

/** A flag carries a `variations` array; a segment never does. */
function isFlag(raw: unknown): raw is LDFlag {
  return typeof raw === 'object' && raw !== null && Array.isArray((raw as {variations?: unknown}).variations)
}

function listFixtureFiles(): string[] {
  if (!existsSync(RAW_DIR)) return []
  return readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
}

describe('migrate/sources/launchdarkly — fixture corpus is canonical', () => {
  const files = listFixtureFiles()

  it(`exports at least ${MIN_CORPUS_SIZE} raw fx-* fixtures into ${RAW_DIR}`, () => {
    expect(files.length, `found ${files.length} fixture files in ${RAW_DIR}`).to.be.at.least(MIN_CORPUS_SIZE)
    // Every corpus fixture key is an `fx-*` key, mirroring the live account.
    for (const file of files) {
      expect(file, `${file} is not an fx-* fixture`).to.match(/^fx-/)
    }
  })

  it('ships a _snapshot-meta.json with the environment list', () => {
    const metaPath = join(RAW_DIR, '_snapshot-meta.json')
    expect(existsSync(metaPath), `${metaPath} missing`).to.equal(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta
    expect(meta.environments, 'environments must be a non-empty array').to.be.an('array').that.is.not.empty
  })

  it('every raw fixture converts to schema-valid Quonfig (translate + validateFileMap, zero errors)', () => {
    const meta = JSON.parse(readFileSync(join(RAW_DIR, '_snapshot-meta.json'), 'utf8')) as SnapshotMeta
    const report = new ConversionReport()
    const fileMap = new Map<string, string>()
    fileMap.set('quonfig.json', JSON.stringify({environments: meta.environments}))

    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as unknown
      if (isFlag(raw)) {
        fileMap.set(flagOutputPath(raw.key), JSON.stringify(translateFlag(raw, report), null, 2))
      } else {
        const segment = raw as LDSegment
        fileMap.set(segmentOutputPath(segment.key), JSON.stringify(translateSegment(segment, report), null, 2))
      }
    }

    const result = validateFileMap(fileMap)
    const errors = result.issues.filter((i) => i.severity === 'error')
    expect(errors, JSON.stringify(errors, null, 2)).to.deep.equal([])
  })
})
