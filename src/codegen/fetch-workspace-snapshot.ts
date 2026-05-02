import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {BaseCommand} from '../index.js'

import {mintAndStoreGiteaReadToken} from '../util/gitea-api.js'
import {isGiteaTokenExpired, loadGiteaToken} from '../util/gitea-token-storage.js'
import {gitClone} from '../util/git-ops.js'
import {resolveWorkspaceUuid} from '../util/resolve-workspace.js'

export interface WorkspaceSnapshot {
  cleanup: () => Promise<void>
  dir: string
}

const looksLike401 = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('401') || msg.toLowerCase().includes('authentication failed')
}

/**
 * Clone the active workspace into a fresh OS tmp directory and return its path
 * along with a cleanup callback. Used by `qfg generate` so codegen works
 * without requiring `qfg pull` first or a long-lived `--dir` checkout.
 *
 * Mirrors `qfg pull`'s auth/clone path: resolves workspace from
 * QUONFIG_API_KEY/QUONFIG_WORKSPACE or active OAuth profile, mints a Gitea
 * read token (refreshing on 401), then `git clone`s into the tmp dir. The
 * caller is responsible for calling `cleanup()` in a `finally` block.
 */
export async function fetchWorkspaceSnapshot(
  command: BaseCommand,
  options: {workspace?: string} = {},
): Promise<WorkspaceSnapshot> {
  const {workspaceId, orgSlug} = await resolveWorkspaceUuid(command, options.workspace)

  let entry = await loadGiteaToken(workspaceId)
  if (!entry || isGiteaTokenExpired(entry)) {
    command.verboseLog('fetchWorkspaceSnapshot', 'Minting new Gitea read token...')
    entry = await mintAndStoreGiteaReadToken(workspaceId, orgSlug)
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qfg-codegen-'))
  const cleanup = () => fs.promises.rm(tmpDir, {force: true, recursive: true})

  try {
    command.verboseLog('fetchWorkspaceSnapshot', `Cloning workspace ${workspaceId} into ${tmpDir}...`)
    try {
      await gitClone(entry.repoUrl, tmpDir)
    } catch (error) {
      if (looksLike401(error)) {
        command.verboseLog('fetchWorkspaceSnapshot', 'Got 401 on clone, refreshing Gitea token...')
        const fresh = await mintAndStoreGiteaReadToken(workspaceId, orgSlug)
        await gitClone(fresh.repoUrl, tmpDir)
      } else {
        throw error
      }
    }
  } catch (error) {
    await cleanup()
    throw error
  }

  return {cleanup, dir: tmpDir}
}
