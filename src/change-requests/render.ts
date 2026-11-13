/**
 * Text rendering for `qfg cr` and `qfg push --propose` (qfg-5bjew.17).
 *
 * Rule 2.13: title, description, labels, branch names and file text are
 * untrusted. Everything a person typed goes through `sanitizeLine` /
 * `sanitizeBlock`, so terminal escape sequences and control characters never
 * reach the terminal, and a title cannot fake extra output lines (for
 * example a forged "You can merge: yes"). The output leads with the
 * computed diff, which is what a merge lands.
 */

import type {ChangeRequestDetail, ChangeRequestFile, ChangeRequestSummary} from './types.js'

import {getAppUrl} from '../util/domain-urls.js'

/* eslint-disable no-control-regex */
const OSC = /\u001B][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g
const CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
/* eslint-enable no-control-regex */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g

/** One line of untrusted text: escapes and controls removed, line breaks and tabs become spaces. */
export function sanitizeLine(text: null | string | undefined): string {
  if (text === null || text === undefined) return ''
  return String(text)
    .replaceAll(OSC, '')
    .replaceAll(CSI, '')
    .replaceAll(/\r\n|[\t\n\r]/g, ' ')
    .replaceAll(CONTROL, '')
    .replaceAll(BIDI, '')
}

/** Multi-line untrusted text: one sanitized string per line. */
export function sanitizeBlock(text: null | string | undefined): string[] {
  if (text === null || text === undefined) return []
  return String(text)
    .split(/\r\n|\n|\r/)
    .map((line) => sanitizeLine(line))
}

/** The full app URL for a server-returned app path. */
export function absoluteUrl(appPath: string): string {
  if (/^https?:\/\//i.test(appPath)) return appPath
  return `${getAppUrl()}${appPath.startsWith('/') ? '' : '/'}${appPath}`
}

export const short = (sha: null | string | undefined): string => (sha ? sha.slice(0, 7) : '')

const splitLines = (text: null | string): string[] => {
  if (text === null || text === '') return []
  const lines = text.split(/\r\n|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Longest LCS table this renders inline; bigger files point at the web page. */
const MAX_DIFF_CELLS = 4_000_000

type Op = {line: string; t: ' ' | '+' | '-'}

function diffOps(a: string[], b: string[]): Op[] | undefined {
  if (a.length * b.length > MAX_DIFF_CELLS) return undefined
  const n = a.length
  const m = b.length
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({length: n + 1}, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({t: ' ', line: a[i]})
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({t: '-', line: a[i]})
      i++
    } else {
      ops.push({t: '+', line: b[j]})
      j++
    }
  }

  while (i < n) ops.push({t: '-', line: a[i++]})
  while (j < m) ops.push({t: '+', line: b[j++]})
  return ops
}

/**
 * A readable line diff of two raw file texts (null = absent side): changed
 * lines prefixed `- ` / `+ `, two lines of context, `  ...` between hunks.
 * Capped at `maxLines` with a pointer to the web page.
 */
export function lineDiff(before: null | string, after: null | string, opts: {maxLines?: number} = {}): string[] {
  const maxLines = opts.maxLines ?? 40
  const ops = diffOps(splitLines(before), splitLines(after))
  if (!ops) return ['(file too large to diff here; see the web page)']

  const context = 2
  const keep = ops.map(() => false)
  for (const [idx, op] of ops.entries()) {
    if (op.t === ' ') continue
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true
  }

  const out: string[] = []
  let gap = false
  for (const [idx, op] of ops.entries()) {
    if (!keep[idx]) {
      gap = out.length > 0
      continue
    }

    if (gap) {
      out.push('  ...')
      gap = false
    }

    out.push(`${op.t} ${sanitizeLine(op.line)}`)
  }

  if (out.length > maxLines) {
    const rest = out.length - maxLines
    return [...out.slice(0, maxLines), `(${rest} more lines; see the web page)`]
  }

  return out
}

const KIND_LETTER: Record<ChangeRequestFile['kind'], string> = {add: 'A', delete: 'D', modify: 'M'}

/** Why nobody can merge it right now, in a few words. */
export function blockedReason(detail: Pick<ChangeRequestDetail, 'blockedBy'>): string {
  return detail.blockedBy ? sanitizeLine(detail.blockedBy.reason) : 'unknown'
}

function filesHeader(detail: ChangeRequestDetail): string {
  switch (detail.filesSource) {
    case 'main': {
      return 'Changes against main (what a merge would land):'
    }

    case 'fork_point': {
      return 'Changes on the branch since it left main (the merge is blocked, so this is not what would land):'
    }

    case 'landed': {
      const sha = short(detail.merged?.commitSha)
      return `Changes this request landed${sha ? ` in ${sha}` : ''}:`
    }

    default: {
      return 'Changes:'
    }
  }
}

/** The diff section: header, one `K path` line per file with its line diff, segment note. */
export function renderFiles(detail: ChangeRequestDetail): string[] {
  const lines = [filesHeader(detail)]
  if (detail.files === null) {
    lines.push(`  (not available: ${blockedReason(detail)}; see the web page)`)
    return lines
  }

  if (detail.files.length === 0) {
    lines.push('  (no changes)')
    return lines
  }

  for (const file of detail.files) {
    lines.push(`  ${KIND_LETTER[file.kind] ?? '?'} ${sanitizeLine(file.path)}`)
    for (const l of lineDiff(file.before, file.after)) lines.push(`    ${l}`)
  }

  const counts = {add: 0, delete: 0, modify: 0}
  for (const f of detail.files) counts[f.kind] = (counts[f.kind] ?? 0) + 1
  lines.push(
    `  ${detail.files.length} file(s): ${counts.modify} modified, ${counts.add} added, ${counts.delete} deleted`,
  )

  if (detail.files.some((f) => f.path.startsWith('segments/'))) {
    lines.push('  Note: this changes a segment; a segment can change what a protected flag serves.')
  }

  return lines
}

const proposerLine = (s: ChangeRequestSummary): string => {
  const email = s.proposer.email ? ` <${sanitizeLine(s.proposer.email)}>` : ''
  return `Proposed by ${sanitizeLine(s.proposer.label)}${email} via ${sanitizeLine(s.proposer.channel)}${
    s.proposedByCaller ? ' (you)' : ''
  }`
}

export function requiresText(detail: Pick<ChangeRequestDetail, 'callerDenials'>): string {
  return detail.callerDenials.map((d) => `${sanitizeLine(d.requiredPermission)} on ${sanitizeLine(d.path)}`).join(', ')
}

const conflictLines = (detail: ChangeRequestDetail): string[] =>
  detail.conflicts.map(
    (c) => `Conflicts with main: ${sanitizeLine(c.path)} (changed in ${short(sanitizeLine(c.mainCommit))})`,
  )

/** `qfg cr show`: the computed diff first, then who/what/whether. */
export function renderShow(detail: ChangeRequestDetail): string[] {
  const lines = [...renderFiles(detail), '']
  lines.push(
    `Change request #${detail.number} [${detail.status}]`,
    `Title (as written by the proposer): ${sanitizeLine(detail.title)}`,
    `Branch: ${sanitizeLine(detail.branch)} (head ${short(detail.headSha)}, base ${short(detail.baseSha)})`,
    proposerLine(detail),
  )

  const description = sanitizeBlock(detail.description)
  if (description.length > 0) {
    lines.push('Description (as written by the proposer):', ...description.map((l) => `  ${l}`))
  }

  if (detail.status === 'open') {
    const requires = requiresText(detail)
    lines.push(
      ...conflictLines(detail),
      `Mergeable: ${detail.mergeable ? 'yes' : `no (${blockedReason(detail)})`}`,
      `You can merge: ${detail.callerCanMerge ? 'yes' : `no${requires ? ` (Requires: ${requires})` : ''}`}`,
      `You can close: ${detail.callerCanClose ? 'yes' : 'no'}`,
    )
  }

  if (detail.status === 'merged' && detail.merged) {
    const m = detail.merged
    lines.push(
      `Merged by ${sanitizeLine(m.by) || 'unknown'}${m.at ? ` at ${m.at}` : ''}${
        m.commitSha ? ` as ${short(m.commitSha)}` : ''
      }${m.selfMerged ? ' (self-merged)' : ''}`,
    )
  }

  if (detail.status === 'closed' && detail.closed) {
    const c = detail.closed
    lines.push(`Closed by ${sanitizeLine(c.by) || 'unknown'}${c.at ? ` at ${c.at}` : ''}`)
    const note = sanitizeBlock(c.note)
    if (note.length > 0) lines.push('Close note:', ...note.map((l) => `  ${l}`))
  }

  lines.push(absoluteUrl(detail.url))
  return lines
}

/** What `qfg cr merge` prints before asking: title, proposer, the diff, conflicts. */
export function renderMergeSummary(detail: ChangeRequestDetail): string[] {
  return [
    `Change request #${detail.number} [${detail.status}]: ${sanitizeLine(detail.title)}`,
    proposerLine(detail),
    ...renderFiles(detail),
    ...conflictLines(detail),
  ]
}

/** `qfg cr list` rows. */
export function renderList(rows: ChangeRequestSummary[], status: string): string[] {
  if (rows.length === 0) return [status === 'all' ? 'No change requests.' : `No ${status} change requests.`]
  return rows.map((r) =>
    [
      `#${r.number}`,
      r.status,
      sanitizeLine(r.branch),
      sanitizeLine(r.proposer.label),
      sanitizeLine(r.updatedAt).slice(0, 10),
      sanitizeLine(r.title),
    ].join('  '),
  )
}
