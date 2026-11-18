/**
 * `--propose` / `--cr <n>` on the write commands (qfg-5bjew.37, change
 * requests step 3): propose a change without a clone. The command builds
 * the document exactly as a live write would, then sends it to
 * `changeRequests.propose` (app-quonfig src/lib/api/change-request-propose.server.ts)
 * instead of the update route. Nothing goes live until someone with rights
 * merges the request.
 *
 * Also the 403 hint (rule 2.11, CLI channel): a refused live write prints the
 * same command with `--propose` added.
 *
 * Rule 2.12 analog: a proposal FAILS unless the response carries
 * `changeRequest.number`. An older server 404s the route, and that must read
 * as "server too old", never as success.
 */

import {Flags} from '@oclif/core'

import type {APICommand} from '../index.js'
import type {JsonObj} from '../result.js'
import type {ChangeRequestDetail} from './types.js'

import {checkmark} from '../util/color.js'
import {absoluteUrl, sanitizeLine} from './render.js'

export const proposeFlags = {
  cr: Flags.integer({
    description:
      'add this change to your open change request #<n> instead of opening a new one (implies --propose; only the proposer can add)',
    min: 1,
  }),
  description: Flags.string({description: 'change request description (with --propose or --cr)'}),
  propose: Flags.boolean({
    default: false,
    description:
      'propose the change as a change request instead of applying it: NOT LIVE until someone with rights merges it (no --confirm needed)',
  }),
  title: Flags.string({description: 'change request title (with --propose; defaults to a summary of the change)'}),
}

export interface ProposeFlagValues {
  cr?: number
  description?: string
  propose?: boolean
  title?: string
}

/** What the caller asked for: undefined = a live write. */
export interface ProposeOptions {
  changeRequest?: number
  description?: string
  title?: string
}

/** `--propose`, `--cr <n>` (implies --propose); --title/--description need one of them. */
export function parseProposeFlags(
  flags: ProposeFlagValues,
): {error: string; ok: false} | {ok: true; options: ProposeOptions | undefined} {
  const proposing = Boolean(flags.propose) || flags.cr !== undefined
  if (!proposing) {
    if (flags.title !== undefined || flags.description !== undefined) {
      return {error: '--title and --description need --propose (or --cr <n>)', ok: false}
    }

    return {ok: true, options: undefined}
  }

  if (flags.cr !== undefined && (flags.title !== undefined || flags.description !== undefined)) {
    return {
      error: `--title and --description name a NEW change request; #${flags.cr} keeps its own. Drop them, or use --propose without --cr.`,
      ok: false,
    }
  }

  return {
    ok: true,
    options: {
      ...(flags.cr === undefined ? {} : {changeRequest: flags.cr}),
      ...(flags.title === undefined ? {} : {title: flags.title}),
      ...(flags.description === undefined ? {} : {description: flags.description}),
    },
  }
}

/** The three document families a proposal writes (server `proposalDocumentTypeSchema`). */
export type ProposalDocumentType = 'config' | 'flag' | 'log-level'

/** metadata `type` -> proposal document type, or undefined for segments/schemas. */
export function proposalTypeFor(metadataType: string): ProposalDocumentType | undefined {
  switch (metadataType) {
    case 'feature_flag': {
      return 'flag'
    }

    case 'config': {
      return 'config'
    }

    case 'log_level': {
      return 'log-level'
    }

    default: {
      return undefined
    }
  }
}

const DIRECTORY: Record<ProposalDocumentType, string> = {
  config: 'configs',
  flag: 'feature-flags',
  'log-level': 'log-levels',
}

/** Path of a document in the workspace repo. */
export function documentPathFor(type: ProposalDocumentType, key: string): string {
  return `${DIRECTORY[type]}/${key}.json`
}

/** The proposal type for a repo path, or undefined when proposals cannot write it. */
export function proposalTypeForPath(path: string): {key: string; type: ProposalDocumentType} | undefined {
  for (const [type, dir] of Object.entries(DIRECTORY) as [ProposalDocumentType, string][]) {
    const prefix = `${dir}/`
    if (path.startsWith(prefix) && path.endsWith('.json') && !path.slice(prefix.length).includes('/')) {
      return {key: path.slice(prefix.length, -'.json'.length), type}
    }
  }

  return undefined
}

/**
 * The stored document from a `metadata/getByKey` read, minus the git
 * metadata that rides alongside it (`commitSha`, `lastModified`), which is
 * never part of the file.
 */
export function storedDocument(read: Record<string, unknown>): Record<string, unknown> {
  const doc = {...read}
  delete doc.commitSha
  delete doc.lastModified
  return doc
}

/**
 * A live update route's partial fields applied to the document it was read
 * from, the way app-quonfig `updateEntity` does (top-level fields replaced).
 */
export function applyUpdateFields(
  read: Record<string, unknown>,
  updateFields: Record<string, unknown>,
): Record<string, unknown> {
  const doc = storedDocument(read)
  for (const [field, value] of Object.entries(updateFields)) {
    if (value !== undefined) doc[field] = value
  }

  return doc
}

// ── --cr <n>: where the change is built from ──────────────────────────────

/**
 * Where a `--cr <n>` change starts. When #N already changes the key's file,
 * the command builds from the request's version and uses the branch head as
 * the "version I read" token. Otherwise it builds from main as usual; the
 * server's compare-and-swap against the branch tip refuses if main moved that
 * file since the request was opened.
 */
export type CrBase =
  {document: Record<string, unknown>; headSha: string; inRequest: true} | {headSha: string; inRequest: false}

type CommandWithApi = Pick<APICommand, 'apiClient' | 'err' | 'workspaceId'>

export async function loadCrBase(
  cmd: CommandWithApi,
  number: number,
  type: ProposalDocumentType,
  key: string,
): Promise<CrBase> {
  const res = await cmd.apiClient.post('/api/v1/changeRequests/get', {workspaceId: cmd.workspaceId, number})
  if (!res.ok) {
    if (res.status === 404) return cmd.err(`Change request #${number} not found in this workspace.`)
    return cmd.err(`Could not load change request #${number}: ${res.status} ${errorMessageOf(res) ?? ''}`.trim(), {
      serverError: res.error,
    })
  }

  const detail = res.json as unknown as ChangeRequestDetail
  if (detail.status !== 'open') {
    return cmd.err(
      `Change request #${number} is ${detail.status}; nothing can be added to it. Propose a new one with --propose.`,
      {reason: 'not_open', status: detail.status},
    )
  }

  const path = documentPathFor(type, key)
  const file = detail.files?.find((f) => f.path === path)
  if (!file) return {headSha: detail.headSha, inRequest: false}
  if (file.after === null) {
    return cmd.err(`${key} is deleted in change request #${number}; nothing to change there.`, {
      reason: 'deleted_in_change_request',
    })
  }

  let document: unknown
  try {
    document = JSON.parse(file.after)
  } catch {
    return cmd.err(`${path} in change request #${number} is not valid JSON.`)
  }

  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return cmd.err(`${path} in change request #${number} is not a JSON object.`)
  }

  return {document: document as Record<string, unknown>, headSha: detail.headSha, inRequest: true}
}

// ── Sending the proposal ──────────────────────────────────────────────────

/** One entry of `changeRequests.propose` (server `ProposalChangeSchema`). */
export type ProposalChange = {op: string} & Record<string, unknown>

export interface ProposedChangeRequest {
  branch?: string
  changes?: {key: string; summary?: string[]; type: string}[]
  headSha?: string
  number: number
  status?: string
  url: string
}

export interface ProposeResponse {
  applied?: boolean
  changeRequest?: ProposedChangeRequest
  message?: string
}

export const SERVER_TOO_OLD =
  'The server did not open a change request (it may be older than this CLI). Nothing is proposed and nothing went live.'

function errorMessageOf(res: {error?: unknown; serverMessage?: string}): string | undefined {
  if (res.serverMessage) return res.serverMessage
  const e = res.error as {error?: unknown; message?: unknown} | undefined
  if (e && typeof e.message === 'string' && e.message) return e.message
  if (e && typeof e.error === 'string' && e.error) return e.error
  return undefined
}

/** A route that is not there at all (an older server): 404 with no domain message. */
function isMissingRoute(status: number, message: string | undefined): boolean {
  return status === 404 && (!message || /^not found\.?$/i.test(message.trim()))
}

/**
 * The user-facing error for a refused proposal. `ChangedInChangeRequest` is
 * Q15 (the server will not replace a whole document a request already
 * changes); the server's text names MCP ops, so the CLI says what to do here.
 */
export function proposeFailureMessage(
  status: number,
  message: string | undefined,
  data: Record<string, unknown> | undefined,
  key?: string,
): string {
  if (isMissingRoute(status, message)) return SERVER_TOO_OLD
  if (status === 409 && data?.reason === 'ChangedInChangeRequest') {
    const n = typeof data.number === 'number' ? data.number : undefined
    const what = key ?? 'This item'
    return n === undefined
      ? `${what} is already changed in that change request, and this command cannot revise it there. Close the request and propose again with all of your changes.`
      : `${what} is already changed in change request #${n}, and this command cannot revise it there. Close it (qfg cr close ${n}) and propose again with all of your changes.`
  }

  const text = message ? sanitizeLine(message) : `HTTP ${status}`
  return `Failed to propose: ${status}: ${text}`
}

/**
 * Validate a 2xx propose response (rule 2.12 analog): no number, no success.
 * Returns the change request or an error message.
 */
export function readProposeResponse(
  json: unknown,
): {error: string; ok: false} | {changeRequest: ProposedChangeRequest; message?: string; ok: true} {
  const body = (json ?? {}) as ProposeResponse
  const cr = body.changeRequest
  if (!cr || typeof cr.number !== 'number' || !Number.isInteger(cr.number) || cr.number <= 0) {
    return {error: SERVER_TOO_OLD, ok: false}
  }

  return {changeRequest: cr, ok: true, ...(typeof body.message === 'string' ? {message: body.message} : {})}
}

/** The success text: number, URL, NOT LIVE on its own line, then where to look. */
export function proposedLines(cr: ProposedChangeRequest, opts: {added: boolean}): string[] {
  const lines = [
    `${checkmark} ${opts.added ? 'Added to' : 'Opened'} change request #${cr.number}.`,
    `  ${absoluteUrl(cr.url)}`,
  ]
  for (const change of cr.changes ?? []) {
    for (const s of change.summary ?? []) lines.push(`  ${sanitizeLine(change.key)}: ${sanitizeLine(s)}`)
  }

  lines.push('NOT LIVE', `Check on it: qfg cr show ${cr.number} / Wait: qfg cr wait ${cr.number}`)
  return lines
}

/** `--json`: `{proposed: true, applied: false, changeRequest}` with an absolute url. */
export function proposedJson(cr: ProposedChangeRequest): JsonObj {
  return {applied: false, changeRequest: {...cr, url: absoluteUrl(cr.url)}, proposed: true}
}

/**
 * Send `changes` to `changeRequests.propose`, print the result and return
 * the `--json` body. Fails (exit 1) on any refusal or a response without a
 * change-request number.
 */
export async function submitProposal(
  cmd: Pick<APICommand, 'apiClient' | 'err' | 'log' | 'workspaceId'>,
  input: {changes: ProposalChange[]; key?: string; options: ProposeOptions},
): Promise<JsonObj> {
  const {options} = input
  const body = {
    workspaceId: cmd.workspaceId,
    ...(options.changeRequest === undefined ? {} : {changeRequest: options.changeRequest}),
    ...(options.title === undefined ? {} : {title: options.title}),
    ...(options.description === undefined ? {} : {description: options.description}),
    changes: input.changes,
  }
  const res = await cmd.apiClient.post('/api/v1/changeRequests/propose', body)
  if (!res.ok) {
    const error = res.error as {data?: unknown} | undefined
    const data = error?.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : undefined
    return cmd.err(proposeFailureMessage(res.status, errorMessageOf(res), data, input.key), {
      ...(input.key === undefined ? {} : {key: input.key}),
      proposed: false,
      serverError: res.error,
      status: res.status,
    })
  }

  const read = readProposeResponse(res.json)
  if (!read.ok) return cmd.err(read.error, {proposed: false, reason: 'no_change_request_number'})

  for (const line of proposedLines(read.changeRequest, {added: options.changeRequest !== undefined})) cmd.log(line)
  return proposedJson(read.changeRequest)
}

// ── The 403 hint (rule 2.11, CLI channel) ─────────────────────────────────

const SAFE_TOKEN = /^[\w%+,./:=@-]+$/

function shellQuote(token: string): string {
  if (token !== '' && SAFE_TOKEN.test(token)) return token
  return `'${token.replaceAll("'", String.raw`'\''`)}'`
}

const VALUE_FLAGS = new Set(['--value'])

/**
 * The exact command the user ran, with `--propose` added. `maskValue` hides
 * the value of `--value` (secrets and confidential values must never be
 * echoed, qfg-38lp).
 */
export function proposeCommandFor(
  bin: string,
  commandId: string,
  argv: string[],
  opts: {maskValue?: boolean} = {},
): string {
  const out: string[] = []
  let maskNext = false
  for (const token of argv) {
    if (maskNext) {
      out.push('<value>')
      maskNext = false
      continue
    }

    if (opts.maskValue) {
      const eq = token.indexOf('=')
      if (eq > 0 && VALUE_FLAGS.has(token.slice(0, eq))) {
        out.push(`${token.slice(0, eq)}=<value>`)
        continue
      }

      if (VALUE_FLAGS.has(token)) {
        out.push(token)
        maskNext = true
        continue
      }
    }

    out.push(shellQuote(token))
  }

  return [bin, commandId.replaceAll(':', ' '), ...out, '--propose'].join(' ')
}

export const PROPOSE_HINT_INTRO = 'You can propose this change instead; someone with rights merges it:'

/** The hint lines printed after a refused live write's server message. */
export function proposeHintLines(proposeCommand: string): string[] {
  return [PROPOSE_HINT_INTRO, `  ${proposeCommand}`]
}

/**
 * Fail a refused (403) live write: the message, then how to propose it.
 * `--json` gains `proposable: true` and `proposeCommand`.
 */
export function failWithProposeHint(
  cmd: Pick<APICommand, 'argv' | 'config' | 'err' | 'id'>,
  message: string,
  json: JsonObj,
  opts: {maskValue?: boolean} = {},
): never {
  const proposeCommand = proposeCommandFor(cmd.config.bin, cmd.id ?? '', cmd.argv, opts)
  return cmd.err([message, ...proposeHintLines(proposeCommand)].join('\n'), {
    ...json,
    proposable: true,
    proposeCommand,
  })
}
