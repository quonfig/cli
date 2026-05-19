/**
 * Datadir discovery for `qfg serve`.
 *
 * Resolution order (plan §4):
 *   1. --datadir flag
 *   2. QUONFIG_DIR env var
 *   3. ./our-config if present
 *   4. ./.quonfig if present
 *   5. error
 *
 * Kept narrow on purpose: `qfg pull`/`qfg push` use a richer
 * `resolveWorkspaceDir` helper that walks up looking for `quonfig.json` — but
 * `qfg serve` is intentionally cwd-relative (the user said "serve THIS dir")
 * and the walk would surface a confusing path on a misconfigured repo. The
 * default-pair lookup mirrors `qfg pull --dir` defaults documented in the
 * plan.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEFAULT_DATADIR_CANDIDATES = ['our-config', '.quonfig'] as const

export const NO_DATADIR_ERROR =
  'No datadir found. Pass --datadir <path>, set QUONFIG_DIR, ' +
  `or run from a directory containing ${DEFAULT_DATADIR_CANDIDATES.map((c) => `./${c}`).join(' or ')}.`

export interface ResolveDatadirInput {
  cwd: string
  envDatadir: string | undefined
  flagDatadir: string | undefined
}

export type ResolveDatadirResult =
  | {kind: 'ok'; dir: string; source: 'flag' | 'env' | 'cwd-default'}
  | {kind: 'error'; message: string}

const blank = (s: string | undefined): boolean => s === undefined || s === ''

export const resolveDatadirForServe = (input: ResolveDatadirInput): ResolveDatadirResult => {
  if (!blank(input.flagDatadir)) {
    return {kind: 'ok', dir: path.resolve(input.cwd, input.flagDatadir as string), source: 'flag'}
  }

  if (!blank(input.envDatadir)) {
    return {kind: 'ok', dir: path.resolve(input.cwd, input.envDatadir as string), source: 'env'}
  }

  for (const candidate of DEFAULT_DATADIR_CANDIDATES) {
    const abs = path.resolve(input.cwd, candidate)
    if (fs.existsSync(abs)) {
      return {kind: 'ok', dir: abs, source: 'cwd-default'}
    }
  }

  return {kind: 'error', message: NO_DATADIR_ERROR}
}
