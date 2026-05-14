/**
 * Export the canonical LaunchDarkly fixture corpus into the cli repo.
 *
 * Runs the Phase-1 config-snapshot fetcher (`src/migrate/sources/launchdarkly/api.ts`)
 * against the live `competitor-launchdarkly` LaunchDarkly account, then splits the
 * snapshot into one raw JSON file per `fx-*` flag and segment under
 * `test/migrate/fixtures/launchdarkly/raw/`. Shared snapshot metadata
 * (environment keys, context kinds) lands in `raw/_snapshot-meta.json`.
 *
 * This is the corpus the converter golden tests (plan §6.1) build against — see
 * `test/migrate/fixtures/launchdarkly/raw/CORPUS.md`. Re-run it to refresh the
 * corpus when the account changes; the output is deterministic (keys sorted).
 * Hand-authored backfill fixtures (CORPUS.md §"Backfilled") are left untouched —
 * the exporter only ever writes the keys the live account actually returns.
 *
 * Auth: a LaunchDarkly REST API token (raw, no `Bearer` prefix). Resolution order:
 *   1. `LAUNCHDARKLY_API_KEY` env var
 *   2. `--token-file <path>`
 *   3. `../competitor-launchdarkly/.ld-api-token` (the account that hosts the corpus)
 * The token is never written to disk or logged.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/export-ld-fixtures.ts
 *   LAUNCHDARKLY_API_KEY=api-xxxx node --loader ts-node/esm scripts/export-ld-fixtures.ts
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {applyLaunchDarklyBaseUrl, fetchFlags, fetchSnapshot} from '../src/migrate/sources/launchdarkly/api.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = resolve(SCRIPT_DIR, '..')
const RAW_DIR = join(CLI_ROOT, 'test', 'migrate', 'fixtures', 'launchdarkly', 'raw')
const DEFAULT_TOKEN_FILE = resolve(CLI_ROOT, '..', 'competitor-launchdarkly', '.ld-api-token')
/** The corpus lives in the `default` project; matches the fixture generator. */
const PROJECT_KEY = process.env.LAUNCHDARKLY_PROJECT_KEY ?? 'default'
/** Only `fx-*` keys are corpus fixtures — anything else in the account is noise. */
const FIXTURE_PREFIX = 'fx-'

function resolveToken(): string {
  const fromEnv = process.env.LAUNCHDARKLY_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const flagIdx = process.argv.indexOf('--token-file')
  const tokenFile = flagIdx !== -1 && process.argv[flagIdx + 1] ? process.argv[flagIdx + 1] : DEFAULT_TOKEN_FILE

  if (!existsSync(tokenFile)) {
    throw new Error(`No LaunchDarkly API token: set LAUNCHDARKLY_API_KEY, pass --token-file, or create ${tokenFile}`)
  }

  return readFileSync(tokenFile, 'utf8').trim()
}

/** Sort object keys recursively so re-exports produce stable, reviewable diffs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]),
  )
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, val) => sortKeys(val), 2)}\n`
}

async function main(): Promise<void> {
  applyLaunchDarklyBaseUrl()
  const token = resolveToken()

  console.log(`Fetching Phase-1 snapshot for project "${PROJECT_KEY}"…`)
  const snapshot = await fetchSnapshot(token, PROJECT_KEY)

  // The snapshot fetcher hides archived flags (the migration runtime does not
  // want them). The corpus does — `state-archived` is a matrix fixture — so the
  // exporter takes the second, archived-only pass `fetchSnapshot` deliberately skips.
  console.log('Fetching archived flags (corpus-only pass)…')
  const archivedFlags = await fetchFlags(token, PROJECT_KEY, snapshot.environments, {archived: true})
  const allFlags = [...snapshot.flags, ...archivedFlags]

  const flags = allFlags.filter((f) => f.key.startsWith(FIXTURE_PREFIX)).sort((a, b) => a.key.localeCompare(b.key))
  const segments = snapshot.segments
    .filter((s) => s.key.startsWith(FIXTURE_PREFIX))
    .sort((a, b) => a.key.localeCompare(b.key))

  console.log(
    `Snapshot: ${allFlags.length} flags (${archivedFlags.length} archived) / ${snapshot.segments.length} segments ` +
      `total; ${flags.length} flags + ${segments.length} segments match "${FIXTURE_PREFIX}".`,
  )

  mkdirSync(RAW_DIR, {recursive: true})

  let written = 0
  for (const flag of flags) {
    writeFileSync(join(RAW_DIR, `${flag.key}.json`), stableJson(flag))
    written++
  }

  for (const segment of segments) {
    writeFileSync(join(RAW_DIR, `${segment.key}.json`), stableJson(segment))
    written++
  }

  writeFileSync(
    join(RAW_DIR, '_snapshot-meta.json'),
    stableJson({
      contextKinds: [...snapshot.contextKinds].sort(),
      environments: [...snapshot.environments].sort(),
      exportedAt: new Date().toISOString().slice(0, 10),
      flagCount: flags.length,
      project: PROJECT_KEY,
      segmentCount: segments.length,
    }),
  )

  console.log(`Wrote ${written} fixture files + _snapshot-meta.json to ${RAW_DIR}`)
}

try {
  await main()
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
