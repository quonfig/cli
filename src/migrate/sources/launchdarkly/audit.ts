/**
 * LaunchDarkly REST API client — Phase-2 history backfill (`--full-summary`).
 *
 * Phase 1 (`api.ts`) is a fast current-state snapshot. Phase 2 is the slow,
 * resumable audit-log walk that reifies every historical flag change into its
 * own git commit with the original author, date and message.
 *
 * Hard constraints, straight from `project/plans/migrator-launch-darkly.md`
 * §4.1 / §4.1.1 — all surfaced to the user, none worked around silently:
 *
 * - The audit log is a *forward event stream*, not a versioned object store.
 *   There is no point-in-time endpoint; each `/auditlog/{id}` entry carries the
 *   full `currentVersion` of the resource as of that change, which is exactly
 *   what we need to reify a commit.
 * - `/auditlog` caps `limit` at 20 and is account-wide. A large account is tens
 *   of thousands of events → 10k–50k+ calls → hours. The walk MUST be
 *   checkpointed/resumable — `walkAuditLog` cursors on `before` and emits an
 *   `onCheckpoint` after every page so a crashed run resumes where it stopped.
 * - Retention is plan-gated: LD Developer plans retain only the last 30 days.
 *   `probeRetentionHorizon` is the up-front pre-flight — it tells the user the
 *   real horizon BEFORE the slow phase starts, so nobody waits hours expecting
 *   two years and silently gets thirty days.
 * - `delta` is null for semantic-patch updates, so we rely on `currentVersion`,
 *   never `delta`.
 */

import type {CommitMeta, LegacyChange} from '../../source.js'
import type {LDFlag} from './types.js'

import {apiFetch} from './api.js'

const SOURCE_NAME = 'launchdarkly'
/** `/auditlog` hard-caps `limit` at 20 — see plan §4.1. */
const AUDIT_PAGE_LIMIT = 20
const DAY_MS = 86_400_000

/**
 * Retention boundaries the pre-flight probe brackets against, in days. The
 * 30-day mark is the LD Developer-plan retention ceiling; the rest bracket the
 * "how far does this account actually retain" question cheaply (one `limit=1`
 * call each) instead of walking the whole log just to find its floor.
 */
const RETENTION_PROBE_DAYS = [30, 90, 180, 365, 730] as const

/** The human actor on an audit-log entry. Absent for token / integration actors. */
export interface LDAuditActor {
  _id?: string
  email?: string
  firstName?: string
  lastName?: string
}

/** A row from the `/auditlog` listing — enough to page and to hydrate. */
export interface LDAuditLogListEntry {
  _id: string
  /** Epoch ms — the change timestamp and the `before` pagination cursor. */
  date: number
  name?: string
  titleVerb?: string
}

/**
 * A fully hydrated `/auditlog/{id}` entry. `currentVersion` is the full
 * resource representation as of this change — for a flag entry it is an
 * `LDFlag`, which `translate()` consumes directly.
 */
export interface LDAuditLogEntry extends LDAuditLogListEntry {
  app?: {name?: string}
  comment?: string
  /** Null for semantic-patch updates — never relied on; see file header. */
  delta?: unknown
  description?: string
  member?: LDAuditActor
  previousVersion?: unknown
  shortDescription?: string
  target?: {name?: string; resources?: string[]}
  token?: {name?: string}
  currentVersion?: LDFlag
}

interface LDAuditLogPage {
  _links?: {next?: {href: string}}
  items: LDAuditLogListEntry[]
}

/** Result of the up-front retention pre-flight (plan §4.1.1). */
export interface RetentionHorizon {
  /**
   * True when no audit entry older than 30 days was found — the account is
   * almost certainly on an LD Developer plan and pre-window history is gone.
   */
  developerPlanLikely: boolean
  /** Human-readable summary for the CLI to print before the slow phase. */
  label: string
  /**
   * Epoch ms of the oldest entry the bracket probe could reach, or null when
   * nothing older than 30 days is retained.
   */
  oldestReachableMs: null | number
}

export interface WalkAuditLogOptions {
  /** Floor — stop once the stream reaches entries at or before this epoch ms. */
  after?: number
  /**
   * Resumable checkpoint hook — invoked after every listing page with the
   * `before` cursor to restart from. Persist this so a crashed multi-hour walk
   * resumes instead of restarting.
   */
  onCheckpoint?: (before: number) => Promise<void> | void
  /** LD resource spec, e.g. `proj/<key>:env/*:flag/*`. See `buildFlagAuditSpec`. */
  spec?: string
  /** Resume cursor — start strictly older than this epoch ms instead of newest. */
  startBefore?: number
}

/** The LD audit-log resource spec that scopes the walk to every flag in a project. */
export function buildFlagAuditSpec(projectKey: string): string {
  return `proj/${projectKey}:env/*:flag/*`
}

/** One page of the `/auditlog` listing. `limit` is pinned to the API's max of 20. */
export async function fetchAuditLogPage(
  apiKey: string,
  opts: {after?: number; before?: number; spec?: string} = {},
): Promise<LDAuditLogPage> {
  const params = new URLSearchParams({limit: String(AUDIT_PAGE_LIMIT)})
  if (opts.before !== undefined) params.set('before', String(opts.before))
  if (opts.after !== undefined) params.set('after', String(opts.after))
  if (opts.spec) params.set('spec', opts.spec)

  const data = (await apiFetch(`/auditlog?${params}`, apiKey)) as LDAuditLogPage
  return {_links: data._links, items: Array.isArray(data.items) ? data.items : []}
}

/** Hydrate one listing row into a full entry — this is the call that carries `currentVersion`. */
export async function fetchAuditLogEntry(apiKey: string, id: string): Promise<LDAuditLogEntry> {
  return (await apiFetch(`/auditlog/${encodeURIComponent(id)}`, apiKey)) as LDAuditLogEntry
}

/**
 * Walk the audit log newest-to-oldest, hydrating every listing row. Pages on
 * the `before` cursor (the oldest `date` seen so far) so the walk is resumable:
 * pass `startBefore` to resume, and persist each `onCheckpoint(before)` value.
 *
 * Terminates on the first empty page; an `after` floor stops it early. A
 * non-decreasing cursor (a misbehaving API or a same-ms tie at a page edge)
 * also terminates the walk rather than looping forever.
 */
export async function* walkAuditLog(apiKey: string, opts: WalkAuditLogOptions = {}): AsyncIterable<LDAuditLogEntry> {
  let before: number | undefined = opts.startBefore
  const seenCursors = new Set<number>()

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchAuditLogPage(apiKey, {
      ...(opts.after !== undefined ? {after: opts.after} : {}),
      ...(before !== undefined ? {before} : {}),
      ...(opts.spec ? {spec: opts.spec} : {}),
    })

    if (page.items.length === 0) break

    let crossedFloor = false
    for (const item of page.items) {
      if (opts.after !== undefined && item.date <= opts.after) {
        crossedFloor = true
        break
      }

      // eslint-disable-next-line no-await-in-loop
      yield await fetchAuditLogEntry(apiKey, item._id)
    }

    if (crossedFloor) break

    // The oldest entry on the page is the cursor for the next (older) page.
    const nextBefore = page.items[page.items.length - 1].date
    // eslint-disable-next-line no-await-in-loop
    if (opts.onCheckpoint) await opts.onCheckpoint(nextBefore)

    if ((before !== undefined && nextBefore >= before) || seenCursors.has(nextBefore)) break
    seenCursors.add(nextBefore)
    before = nextBefore
  }
}

/**
 * Up-front retention pre-flight (plan §4.1.1). Brackets the account's retention
 * window with one cheap `limit=1` probe per boundary instead of walking the
 * whole log. An empty 30-day probe means the account retains ≤ 30 days — almost
 * certainly an LD Developer plan, and pre-window history is permanently gone.
 */
export async function probeRetentionHorizon(
  apiKey: string,
  opts: {now?: number; spec?: string} = {},
): Promise<RetentionHorizon> {
  const now = opts.now ?? Date.now()
  let oldestReachableMs: null | number = null

  for (const days of RETENTION_PROBE_DAYS) {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchAuditLogPage(apiKey, {
      before: now - days * DAY_MS,
      ...(opts.spec ? {spec: opts.spec} : {}),
    })

    // First empty boundary is the retention floor — stop bracketing deeper.
    if (page.items.length === 0) break
    oldestReachableMs = page.items[0].date
  }

  const label =
    oldestReachableMs === null
      ? 'LaunchDarkly retained ≤ 30 days of audit history (likely a Developer plan) — pre-window history is permanently gone.'
      : `LaunchDarkly audit history reaches back to at least ${new Date(oldestReachableMs).toISOString().slice(0, 10)}.`

  return {developerPlanLikely: oldestReachableMs === null, label, oldestReachableMs}
}

/**
 * The `LegacyChange.raw` payload for a Phase-2 audit change. Extends the
 * Phase-1 `{kind: 'flag', data}` shape `translate()` already understands with
 * the originating `auditEntry`, so the source's `getCommitMeta` can reify the
 * original author / date / message without a second lookup.
 */
export interface LaunchDarklyFlagAuditRaw {
  auditEntry: LDAuditLogEntry
  data: LDFlag
  kind: 'flag'
}

/** True when an audit entry's `currentVersion` is shaped like an `LDFlag`. */
function isFlagVersion(version: unknown): version is LDFlag {
  return (
    typeof version === 'object' &&
    version !== null &&
    typeof (version as {key?: unknown}).key === 'string' &&
    Array.isArray((version as {variations?: unknown}).variations)
  )
}

/**
 * Map a hydrated audit entry to a `LegacyChange`. The `currentVersion` flag
 * snapshot is carried as the `{kind: 'flag', data}` payload `translate()`
 * already understands, so Phase-2 history reuses the Phase-1 converter
 * unchanged. Returns null for entries that carry no flag `currentVersion`
 * (deleted resources, non-flag audit rows) — those are skipped, not crashed.
 */
export function auditEntryToLegacyChange(entry: LDAuditLogEntry): LegacyChange | null {
  if (!isFlagVersion(entry.currentVersion)) return null
  return {
    changedAt: entry.date,
    key: entry.currentVersion.key,
    raw: {auditEntry: entry, data: entry.currentVersion, kind: 'flag'} satisfies LaunchDarklyFlagAuditRaw,
    source: SOURCE_NAME,
  }
}

function actorName(member: LDAuditActor): string {
  const full = [member.firstName, member.lastName].filter(Boolean).join(' ').trim()
  return full.length > 0 ? full : (member.email ?? 'LaunchDarkly user')
}

/**
 * Reify an audit entry's original author, timestamp and description into commit
 * metadata for `--full-summary` (plan §7). Returns null when the entry has no
 * human member (token / integration actors) so the caller falls back to the
 * migrator identity rather than inventing an author.
 */
export function getCommitMetaForAuditEntry(entry: LDAuditLogEntry): CommitMeta | null {
  const member = entry.member
  if (!member || !member.email) return null

  const described = entry.shortDescription?.trim() || entry.description?.trim()
  // Empirically many LD audit entries carry no human description; fall back to
  // a stable, key-aware message so `git log` stays readable.
  const message =
    described && described.length > 0
      ? described
      : `migrator: update ${entry.currentVersion?.key ?? entry.name ?? 'flag'}`

  return {author: {email: member.email, name: actorName(member)}, date: entry.date, message}
}
