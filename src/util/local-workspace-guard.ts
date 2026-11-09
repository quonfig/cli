/**
 * Guard for commands that write to a HOSTED workspace (`qfg create`,
 * `qfg set-default`, ...).
 *
 * Those commands target the active login profile, not the directory you run
 * them in. Inside a local-only workspace (made by `qfg init`, so its
 * `quonfig.json` has no `workspace` pin) that is almost never what the user
 * means: the write lands in whatever hosted workspace happens to be the
 * default, and the local files never change. This helper finds that case so
 * the command can refuse instead of writing somewhere unexpected.
 *
 * Pure apart from reading `quonfig.json` — the caller passes cwd, env and home.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {resolveWorkspaceDir} from './resolve-workspace-dir.js'

export interface LocalOnlyWorkspaceInput {
  cwd: string
  /** `QUONFIG_DIR`, which wins over the cwd walk. */
  envDir: string | undefined
  homeDir?: string
}

/**
 * Return the workspace dir when the nearest workspace (QUONFIG_DIR, else the
 * first `quonfig.json` walking up from cwd) is local-only, i.e. its
 * `quonfig.json` has no `workspace` pin. Return `undefined` when there is no
 * workspace, it is pinned to a hosted workspace, or `quonfig.json` cannot be
 * read as an object — an unreadable file is `qfg verify`'s job, not a reason
 * to block a hosted command.
 */
export const findLocalOnlyWorkspace = (input: LocalOnlyWorkspaceInput): string | undefined => {
  const resolved = resolveWorkspaceDir({
    cwd: input.cwd,
    envDir: input.envDir,
    flagDir: undefined,
    homeDir: input.homeDir,
  })
  if (resolved.kind !== 'ok') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(resolved.dir, 'quonfig.json'), 'utf8'))
  } catch {
    return undefined
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const pin = (parsed as {workspace?: unknown}).workspace
  return typeof pin === 'string' && pin.length > 0 ? undefined : resolved.dir
}

export const localOnlyWorkspaceError = (commandId: string, dir: string): string =>
  `${dir} is a local-only Quonfig workspace (its quonfig.json has no "workspace" pin), ` +
  `but \`qfg ${commandId}\` writes to a hosted workspace, not to these files. ` +
  'To change this workspace, edit its JSON files directly and run `qfg verify`. ' +
  'To write to a hosted workspace anyway, pass --workspace <org>/<workspace> or set QUONFIG_WORKSPACE.'
