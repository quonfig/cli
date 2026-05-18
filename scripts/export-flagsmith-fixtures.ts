/**
 * Export the canonical Flagsmith fixture corpus into the cli repo.
 *
 * Runs the Phase-1 config-snapshot fetcher (`src/migrate/sources/flagsmith/api.ts`)
 * against the live `competitor-flagsmith` Flagsmith account (project Test1,
 * id 38856), then splits the snapshot into one raw JSON file per `fx-*` feature
 * and segment under `test/migrate/fixtures/flagsmith/raw/`. Shared snapshot
 * metadata (env api_key → name, segment id → name, tag pool, project id,
 * fetcher git sha) lands in `raw/_snapshot-meta.json`.
 *
 * This is the corpus the converter golden tests (plan §6.1) build against —
 * see `test/migrate/fixtures/flagsmith/CORPUS.md`. Re-run it to refresh the
 * corpus when the live account changes; the output is deterministic (keys
 * sorted, json 2-space indented, trailing newline) so a regen produces a clean
 * diff modulo the snapshotTaken timestamp.
 *
 * Each raw file carries the stitched per-feature bundle
 * (`FlagsmithFeatureWithStates`: feature record + per-env featurestates +
 * segment overrides + identity overrides) or the per-project segment record
 * (`FlagsmithSegment`). The converter (Epic 3) consumes exactly those shapes.
 *
 * Auth: a Flagsmith Admin API token (raw, no `Api-Key` prefix in the env var —
 * the prefix is added by `apiFetch`). Resolution order:
 *   1. `FLAGSMITH_API_KEY` env var (matches the migrate command)
 *   2. `FLAGSMITH_API_TOKEN` env var (matches the live Phase-2 generator script)
 *   3. `--token-file <path>`
 *   4. `../competitor-flagsmith/.flagsmith-api-token`
 * The token is never written to disk or logged.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/export-flagsmith-fixtures.ts
 *   FLAGSMITH_API_KEY=ff-xxxx node --loader ts-node/esm scripts/export-flagsmith-fixtures.ts
 */

import {execSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {applyFlagsmithBaseUrl, fetchSnapshot} from '../src/migrate/sources/flagsmith/api.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = resolve(SCRIPT_DIR, '..')
const RAW_DIR = join(CLI_ROOT, 'test', 'migrate', 'fixtures', 'flagsmith', 'raw')
const DEFAULT_TOKEN_FILE = resolve(CLI_ROOT, '..', 'competitor-flagsmith', '.flagsmith-api-token')
/** The corpus lives in project Test1 (id 38856); override with FLAGSMITH_PROJECT_ID. */
const PROJECT_ID = process.env.FLAGSMITH_PROJECT_ID ?? '38856'
/** Only `fx-*` keys are corpus fixtures — anything else in the account is noise. */
const FIXTURE_PREFIX = 'fx-'

function resolveToken(): string {
  const fromEnv = process.env.FLAGSMITH_API_KEY ?? process.env.FLAGSMITH_API_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const flagIdx = process.argv.indexOf('--token-file')
  const tokenFile = flagIdx !== -1 && process.argv[flagIdx + 1] ? process.argv[flagIdx + 1] : DEFAULT_TOKEN_FILE

  if (!existsSync(tokenFile)) {
    throw new Error(
      `No Flagsmith API token: set FLAGSMITH_API_KEY (or FLAGSMITH_API_TOKEN), pass --token-file, or create ${tokenFile}`,
    )
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

function resolveFetcherSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {cwd: CLI_ROOT, stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

async function main(): Promise<void> {
  applyFlagsmithBaseUrl()
  const token = resolveToken()

  console.log(`Fetching Phase-1 snapshot for project "${PROJECT_ID}"…`)
  const snapshot = await fetchSnapshot(token, PROJECT_ID)

  const features = snapshot.features
    .filter((f) => f.feature.name.startsWith(FIXTURE_PREFIX))
    .sort((a, b) => a.feature.name.localeCompare(b.feature.name))
  const segments = snapshot.segments
    .filter((s) => s.name.startsWith(FIXTURE_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name))

  console.log(
    `Snapshot: ${snapshot.features.length} features / ${snapshot.segments.length} segments total; ` +
      `${features.length} features + ${segments.length} segments match "${FIXTURE_PREFIX}".`,
  )

  mkdirSync(RAW_DIR, {recursive: true})

  let written = 0
  for (const featureBundle of features) {
    writeFileSync(join(RAW_DIR, `${featureBundle.feature.name}.json`), stableJson(featureBundle))
    written++
  }

  for (const segment of segments) {
    writeFileSync(join(RAW_DIR, `${segment.name}.json`), stableJson(segment))
    written++
  }

  writeFileSync(
    join(RAW_DIR, '_snapshot-meta.json'),
    stableJson({
      envNameByApiKey: Object.fromEntries(snapshot.environments.map((e) => [e.api_key, e.name])),
      featureCount: features.length,
      fetcherSha: resolveFetcherSha(),
      projectId: snapshot.project.id,
      projectName: snapshot.project.name,
      segmentCount: segments.length,
      segmentNameById: Object.fromEntries(snapshot.segments.map((s) => [String(s.id), s.name])),
      snapshotTaken: new Date().toISOString(),
      tags: snapshot.tags.map((t) => ({id: t.id, label: t.label})),
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
