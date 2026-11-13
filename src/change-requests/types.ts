/**
 * Wire shapes of the internal change-request routes (qfg-5bjew.15):
 * `POST /api/v1/changeRequests/{list,get,merge,close}`. Mirrors
 * app-quonfig src/lib/orpc/routes/change-requests-handler.ts. Every string
 * a person typed (title, description, labels, branch, file text) is
 * untrusted: render it through render.ts, never raw.
 */

export type ChangeRequestStatus = 'closed' | 'merged' | 'open'

export interface ChangeRequestSummary {
  baseSha: string
  /** Branch name without `refs/heads/`. */
  branch: string
  closed: {at: null | string; by: null | string; note: null | string} | null
  createdAt: string
  headSha: string
  merged: {at: null | string; by: null | string; commitSha: null | string; selfMerged: boolean} | null
  number: number
  proposedByCaller: boolean
  proposer: {channel: string; email: null | string; label: string}
  status: ChangeRequestStatus
  title: string
  updatedAt: string
  /** App-relative page path. */
  url: string
}

export interface ChangeRequestFile {
  after: null | string
  afterOid: null | string
  before: null | string
  beforeOid: null | string
  kind: 'add' | 'delete' | 'modify'
  path: string
}

export interface AuthorizationDenial {
  path: string
  reason: string
  requiredPermission: string
}

export interface ChangeRequestDetail extends ChangeRequestSummary {
  blockedBy: ({reason: string} & Record<string, unknown>) | null
  callerCanClose: boolean
  callerCanMerge: boolean
  callerDenials: AuthorizationDenial[]
  conflicts: {mainCommit: string; path: string}[]
  description: null | string
  files: ChangeRequestFile[] | null
  /** "main": what a merge would land; "fork_point": the branch's own changes; "landed": a merged request. */
  filesSource: 'fork_point' | 'landed' | 'main' | null
  mainSha: null | string
  mergeBase: null | string
  mergeable: boolean
}

export interface ChangeRequestMergeResult {
  mergeCommitSha: string
  mergedAt: string
  number: number
  selfMerged: boolean
  url: string
}

export interface ChangeRequestCloseResult {
  branchDeleted: boolean
  closedAt: string
  number: number
  status: 'closed'
  url: string
}
