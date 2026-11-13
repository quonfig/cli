/**
 * `qfg cr merge <n>` (qfg-5bjew.17, rule 2.1). Dependency-injected so the
 * order is testable: fetch the request, print what would land, refuse
 * locally when it cannot be merged, confirm, then merge with
 * `expectedHeadSha` = the head that was just shown. The server merges only
 * if the branch tip is still that sha, so nothing added after the summary
 * can land under the proposer's name. Never retries.
 */

import type {ChangeRequestDetail, ChangeRequestMergeResult} from './types.js'

import {ChangeRequestApiError} from './client.js'
import {blockedReason, renderMergeSummary, requiresText, sanitizeLine, short} from './render.js'

/** A `qfg cr` failure with a user-facing message (the command exits 1). */
export class CrCommandError extends Error {
  json: Record<string, unknown> | undefined
  constructor(message: string, json?: Record<string, unknown>) {
    super(message)
    this.name = 'CrCommandError'
    this.json = json
  }
}

export interface MergeFlowDeps {
  confirm(prompt: string): Promise<boolean>
  get(number: number): Promise<ChangeRequestDetail>
  log(line: string): void
  merge(number: number, expectedHeadSha: string): Promise<ChangeRequestMergeResult>
}

export type MergeFlowResult =
  {expectedHeadSha: string; kind: 'merged'; result: ChangeRequestMergeResult} | {kind: 'declined'}

export async function runCrMerge(
  input: {canPrompt: boolean; number: number; yes: boolean},
  deps: MergeFlowDeps,
): Promise<MergeFlowResult> {
  const n = input.number
  const detail = await deps.get(n)
  for (const line of renderMergeSummary(detail)) deps.log(line)

  if (detail.status !== 'open') {
    throw new CrCommandError(`Change request #${n} is ${detail.status}; there is nothing to merge.`, {
      reason: 'not_open',
      status: detail.status,
    })
  }

  if (!detail.mergeable) {
    throw new CrCommandError(
      `Change request #${n} cannot be merged right now (${blockedReason(detail)}). Run qfg cr show ${n} for details.`,
      {reason: 'not_mergeable', blockedBy: detail.blockedBy},
    )
  }

  if (!detail.callerCanMerge) {
    const requires = requiresText(detail)
    throw new CrCommandError(
      requires
        ? `You cannot merge change request #${n}. Requires: ${requires}`
        : `You cannot merge change request #${n} with your current permissions.`,
      {reason: 'unauthorized', denials: detail.callerDenials},
    )
  }

  // The tip the user was just shown; the server merges only this.
  const expectedHeadSha = detail.headSha

  if (!input.yes) {
    if (!input.canPrompt) {
      throw new CrCommandError(`Refusing to merge #${n} without confirmation. Pass --yes or run interactively.`)
    }

    const ok = await deps.confirm(`Merge change request #${n} into main? It goes live. [y/N] `)
    if (!ok) {
      deps.log('Aborted, nothing merged.')
      return {kind: 'declined'}
    }
  }

  let result: ChangeRequestMergeResult
  try {
    result = await deps.merge(n, expectedHeadSha)
  } catch (error) {
    if (error instanceof ChangeRequestApiError) {
      if (error.status === 409 && error.data?.reason === 'HeadMoved') {
        const current = typeof error.data.current === 'string' ? short(error.data.current) : 'branch deleted'
        const expected = typeof error.data.expected === 'string' ? error.data.expected : expectedHeadSha
        throw new CrCommandError(
          `Change request #${n} changed since you viewed it (head ${short(expected)} -> ${current}). Nothing merged. Run qfg cr show ${n} and merge again.`,
          {reason: 'HeadMoved', status: 409, expectedHeadSha},
        )
      }

      throw new CrCommandError(`Change request #${n} was not merged: ${sanitizeLine(error.message)}`, {
        status: error.status,
        ...(error.code ? {serverCode: error.code} : {}),
        ...(error.data ? {data: error.data} : {}),
      })
    }

    throw error
  }

  deps.log(
    `Merged change request #${n} into main as ${short(result.mergeCommitSha)}. It is live.${
      result.selfMerged ? ' Self-merged.' : ''
    }`,
  )
  return {kind: 'merged', result, expectedHeadSha}
}
