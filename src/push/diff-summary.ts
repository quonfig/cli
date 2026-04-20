/**
 * Pure diff-summary + destructive-heuristic module for `qfg push`.
 *
 * Implements Guard 3 (pre-push diff summary + destructive-change detection)
 * from `project/plans/cli-git-sync.md`. This module takes a pre-computed
 * list of `FileDelta`s (the caller is responsible for walking local vs.
 * remote trees after `git fetch`) and returns a grouped count + a plain-text
 * rendering suitable for human confirmation.
 *
 * Intentional non-goals:
 *   - No fs / git / network I/O here. Keeps this pure and test-friendly.
 *   - No prompts / TTY handling. The caller owns confirmation UX.
 *   - No ANSI / unicode. Plain ASCII so CI transcripts stay readable.
 */

/** A single file-level change between the local working tree and remote HEAD. */
export interface FileDelta {
  /**
   * `added`    — present locally, absent on remote
   * `modified` — present in both, content differs
   * `deleted`  — absent locally, present on remote
   */
  kind: 'added' | 'deleted' | 'modified'
  /** Path relative to repo root, e.g. `configs/pricing.json`. */
  path: string
}

export interface GroupCounts {
  added: number
  deleted: number
  modified: number
}

export interface DiffSummary {
  /** Per-top-level-dir counts. See `KNOWN_GROUPS`; anything else lands in `other`. */
  byGroup: Record<string, GroupCounts>
  /** Whether any destructive heuristic fired. */
  destructiveReasons: string[]
  /** Human-readable reasons that each destructive heuristic fired (one per rule). */
  isDestructive: boolean
  /**
   * Render the plain-text summary shown before the user confirms.
   * All opts are optional; missing string opts render as `<unknown>`.
   */
  renderText(opts?: {branch?: string; localDir?: string; repoUrl?: string; workspaceSlug?: string}): string
  /** Sum across all groups, plus `filesTouched = added + modified + deleted`. */
  totals: {filesTouched: number} & GroupCounts
}

/**
 * Top-level directories we present as named rows. Anything else funnels into
 * `other`. Keeping this closed-set avoids one-off typos silently looking fine.
 */
const KNOWN_GROUPS = [
  'configs',
  'feature-flags',
  'segments',
  'schemas',
  'schemas-protected',
  'log-levels',
] as const

const DESTRUCTIVE_DELETE_COUNT = 10
const DESTRUCTIVE_DELETE_RATIO = 0.25

function emptyCounts(): GroupCounts {
  return {added: 0, deleted: 0, modified: 0}
}

/**
 * Derive the group label for a path. Top-level dir if it's known, `other`
 * otherwise (including for files at the repo root).
 */
function groupFor(relativePath: string): string {
  const slash = relativePath.indexOf('/')
  if (slash === -1) return 'other'
  const top = relativePath.slice(0, slash)
  return (KNOWN_GROUPS as readonly string[]).includes(top) ? top : 'other'
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

export function summarizeDiff(
  deltas: FileDelta[],
  opts?: {totalFilesInRemote?: number; unpinned?: boolean},
): DiffSummary {
  const byGroup: Record<string, GroupCounts> = {}
  const totals: {filesTouched: number} & GroupCounts = {added: 0, deleted: 0, filesTouched: 0, modified: 0}

  for (const delta of deltas) {
    const group = groupFor(delta.path)
    const counts = byGroup[group] ?? emptyCounts()
    counts[delta.kind] += 1
    byGroup[group] = counts
    totals[delta.kind] += 1
    totals.filesTouched += 1
  }

  const destructiveReasons: string[] = []
  if (totals.deleted >= DESTRUCTIVE_DELETE_COUNT) {
    destructiveReasons.push(`10+ deletes: ${totals.deleted}`)
  }

  const remoteCount = Math.max(opts?.totalFilesInRemote ?? 0, 0)
  if (remoteCount > 0) {
    const ratio = totals.deleted / remoteCount
    if (ratio >= DESTRUCTIVE_DELETE_RATIO) {
      // Strict `>=` — 24.9% does not trip this; 25.0% does.
      destructiveReasons.push(`deletes >= 25% of total: ${totals.deleted}/${remoteCount}`)
    }
  }

  if (opts?.unpinned === true) {
    destructiveReasons.push('workspace unpinned (no `workspace` field in quonfig.json)')
  }

  const isDestructive = destructiveReasons.length > 0

  const renderText: DiffSummary['renderText'] = (renderOpts) => {
    const slug = renderOpts?.workspaceSlug ?? '<unknown>'
    const repo = renderOpts?.repoUrl ?? '<unknown>'
    const branch = renderOpts?.branch ?? 'main'
    const localDir = renderOpts?.localDir ?? '.'

    const lines: string[] = []
    lines.push(`Pushing to workspace:  ${slug}`, `  Git repo:            ${repo}`, `  Branch:              ${branch}`, `  Local dir:           ${localDir}`, '', 'Changes vs. remote HEAD:')

    // Render groups in a stable order: known groups first (in declared order),
    // then `other` if present. Skip rows with zero total activity.
    const renderOrder: string[] = [...KNOWN_GROUPS]
    if (byGroup.other) renderOrder.push('other')

    // Two-space indent, left-pad the label column to `labelWidth` so the
    // +N ~N -N columns line up regardless of group name length.
    const labelWidth = 18 // e.g. "schemas-protected/" = 18 chars
    for (const group of renderOrder) {
      const counts = byGroup[group]
      if (!counts) continue
      if (counts.added === 0 && counts.modified === 0 && counts.deleted === 0) continue
      const label = `${group}/`
      lines.push(`  ${pad(label, labelWidth)}+${counts.added}  ~${counts.modified}  -${counts.deleted}`)
    }

    lines.push('')

    if (isDestructive) {
      lines.push('WARNING:')
      for (const reason of destructiveReasons) {
        lines.push(`  ${reason}`)
      }

      lines.push('')
    }

    lines.push(`  Total: ${totals.added} new files, ${totals.modified} modified, ${totals.deleted} deleted`)

    return lines.join('\n')
  }

  return {
    byGroup,
    destructiveReasons,
    isDestructive,
    renderText,
    totals,
  }
}
