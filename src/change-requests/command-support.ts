/**
 * Shared plumbing for the `qfg cr` commands (qfg-5bjew.17): workspace
 * resolution (same precedence as `qfg push`: --workspace, QUONFIG_WORKSPACE,
 * the workspace dir's quonfig.json pin, the active profile; API-key mode
 * works), the number argument, and turning route errors into messages.
 */

import {Args, Flags} from '@oclif/core'

import type {BaseCommand} from '../index.js'

import {resolveWorkspaceDir} from '../util/resolve-workspace-dir.js'
import {type ResolvedWorkspace, resolveWorkspaceUuid} from '../util/resolve-workspace.js'
import {ChangeRequestApiError} from './client.js'
import {CrCommandError} from './merge-flow.js'
import {sanitizeLine} from './render.js'

export const workspaceFlag = {
  workspace: Flags.string({
    char: 'w',
    description:
      'Workspace as <org>/<workspace> or a UUID (defaults to the workspace dir pin, then the active profile)',
  }),
}

export const numberArg = {
  number: Args.string({description: 'Change request number (for example 7 or #7)', required: true}),
}

export async function resolveCrWorkspace(cmd: BaseCommand, flagWorkspace?: string): Promise<ResolvedWorkspace> {
  const found = resolveWorkspaceDir({flagDir: undefined, envDir: process.env.QUONFIG_DIR, cwd: process.cwd()})
  return resolveWorkspaceUuid(cmd, flagWorkspace, found.kind === 'ok' ? found.dir : undefined)
}

/** `7` or `#7` -> 7; anything else is refused. */
export function parseCrNumber(raw: string): number {
  const m = /^#?(\d+)$/.exec(raw.trim())
  const n = m ? Number.parseInt(m[1], 10) : Number.NaN
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) {
    throw new CrCommandError(`Not a change request number: ${sanitizeLine(raw)}`)
  }

  return n
}

/** A route error as a user-facing CrCommandError (server message, sanitized). */
export function crApiError(error: unknown, what: string, notFound?: string): unknown {
  if (!(error instanceof ChangeRequestApiError)) return error
  if (error.status === 404 && notFound) return new CrCommandError(notFound, {status: 404})
  return new CrCommandError(`${what}: ${sanitizeLine(error.message)}`, {
    status: error.status,
    ...(error.code ? {serverCode: error.code} : {}),
    ...(error.data && typeof error.data.reason === 'string' ? {reason: error.data.reason} : {}),
  })
}

/** Run a cr command body, mapping CrCommandError to `cmd.err` (exit 1). */
export async function runCr<T>(cmd: BaseCommand, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof CrCommandError) return cmd.err(error.message, error.json)
    throw error
  }
}
