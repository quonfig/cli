/**
 * The secrets writer: commit one `secrets/<key>.json` change through
 * app-quonfig's existing `configs.push` route, locked to the snapshot it was
 * built from. Bead qfg-mol-hle, plan section 0 and Q1. Today every write is
 * exactly the one file its commit message names (create, set or delete of
 * one secret); a `quonfig.json` write is refused on purpose. The keyset
 * commands of qfg-mol-5l7 and `qfg secret migrate` will add their own message
 * kinds, and with them multi-file and `quonfig.json` writes (the preflight
 * below already validates those against the new `quonfig.json`).
 *
 * Transport: the bare-path transport of `qfg push` (`callConfigsPush`), not
 * `runPush` and not `qfg migrate --push`'s clone-and-stack engine. The write
 * is built in memory against a fresh snapshot, so there is no local working
 * directory to diff or confirm, and `configs.push` already gives per-file
 * authorization, the push-event audit trail and the `expectedSha` lock.
 * The server must list `secrets/` in its push allow-list (app-quonfig
 * qfg-mol-bkt); until then the route answers 400 and the error says so.
 *
 * Guarantees, checked before any request:
 *   - the lock is the snapshot's HEAD, never a caller-supplied sha;
 *   - add / modify / delete and every `beforeJson` come from the snapshot;
 *   - paths are `secrets/<key>.json` or `quonfig.json` only;
 *   - every secret document passes `assertWritableSecretDocument` and its key
 *     matches its file name;
 *   - the tree the commit would create passes the push hook's validator for
 *     every written file, and for quonfig.json and every secrets/ document
 *     when quonfig.json changes (src/verify `validateFileMap`, as the hook
 *     calls it);
 *   - the commit message is an object only `secretCommitMessage` issues,
 *     built from parts validated at run time, so no plaintext, length or
 *     tail can reach it;
 *   - the write changes exactly the one file the message names, with the
 *     matching kind (create = add, set = modify, delete = delete); for a
 *     create or set, the document holds a value on the message's keyset and
 *     key fingerprint in the message's scope; a modify must change the file;
 *   - the input (message, files, each change's content) is read once, and
 *     what was checked is what is sent;
 *   - `quonfig.json`, when written, is a JSON object;
 *   - every failure, including statuses `callConfigsPush` does not map, is
 *     a SecretWriteError; every piece of server text in it (messages,
 *     denial paths, reasons and permissions) goes through one scrubber that
 *     removes token-bearing URLs, bearer tokens and qf1 values and caps its
 *     length.
 * No plaintext and no private key exists anywhere on this path.
 */
import type {ConfigPushInput, ConfigPushResult, PushDenial, ServerFileDelta} from '../push/run-push.js'

import {KEYSET_NAME_RE, FINGERPRINT_RE} from './qf1.js'
import {SecretDocumentError, assertWritableSecretDocument, secretPath} from './secret-doc.js'
import {SnapshotPathError, type WorkspaceSnapshot} from './workspace-snapshot.js'
import {validateFileMap} from '../verify/validate.js'
import {redactToken} from '../util/git-ops.js'

export type WorkspaceFileChange = {afterJson: string; path: string} | {delete: true; path: string}

/**
 * A commit message built by `secretCommitMessage`. Opaque: the writer
 * accepts only an object this module issued (checked at run time), never a
 * string, so free text cannot reach a commit.
 */
export type SecretCommitMessage = {readonly text: string}

/** What each issued message describes, so the writer can check it against the files written. */
type IssuedMessage = {
  fingerprint?: string
  key: string
  keyset?: string
  scope?: string
  text: string
  verb: 'create' | 'delete' | 'set'
}

const ISSUED_MESSAGES = new WeakMap<object, IssuedMessage>()

export type PushWorkspaceFilesInput = {
  files: WorkspaceFileChange[]
  message: SecretCommitMessage
  orgSlug: string
  /** The snapshot the files were built from: its HEAD is the lock. */
  snapshot: Pick<WorkspaceSnapshot, 'documents' | 'headSha' | 'readFile'>
  workspaceId: string
}

export type SecretWriteErrorCode =
  | 'bad_request'
  | 'conflict'
  | 'denied'
  | 'hook_rejected'
  | 'invalid_input'
  | 'refused'
  | 'server_error'
  | 'unauthorized'
  /** The client cannot know whether the server applied the write. */
  | 'unknown_result'

export class SecretWriteError extends Error {
  readonly code: SecretWriteErrorCode
  readonly denials?: PushDenial[]

  constructor(code: SecretWriteErrorCode, message: string, denials?: PushDenial[]) {
    super(message)
    this.name = 'SecretWriteError'
    this.code = code
    if (denials) this.denials = denials
  }
}

const SHA_RE = /^[\da-f]{40}([\da-f]{24})?$/
const SECRET_FILE_RE = /^secrets\/([^/\\]+)\.json$/
const SCOPE_RE = /^[\w.-]+$/
const QUONFIG_JSON = 'quonfig.json'

function bad(why: string): never {
  throw new SecretWriteError('invalid_input', `cannot build the commit message: ${why}`)
}

function invalid(why: string): never {
  throw new SecretWriteError('invalid_input', why)
}

export type CommitParts =
  | {fingerprint: string; key: string; keyset: string; scope?: string; verb: 'create' | 'set'}
  | {key: string; verb: 'delete'}

const VERBS: ReadonlySet<unknown> = new Set(['create', 'delete', 'set'])

/**
 * `qfg: create secret <key> on <KEYSET> <fp>`, `qfg: set secret <key> (<scope>)
 * on <KEYSET> <fp>`, `qfg: delete secret <key>`. Every part is validated at
 * run time: `verb` against the closed set, the key by the push hook's key
 * rules, the keyset by spec 2, the fingerprint by spec 4, the scope as an
 * environment id. Nothing else can be carried in.
 */
export function secretCommitMessage(parts: CommitParts): SecretCommitMessage {
  if (typeof parts !== 'object' || parts === null) bad('no parts')
  // Each part is read exactly once: an accessor cannot return one value to
  // the checks below and another to the text.
  const p = parts as Record<string, unknown>
  const verb = p.verb
  const key = p.key
  if (!VERBS.has(verb)) bad('unknown verb')
  if (typeof key !== 'string') bad('the key is not a valid secret key')
  try {
    secretPath(key)
  } catch {
    bad('the key is not a valid secret key')
  }

  let issued: IssuedMessage
  if (verb === 'delete') {
    issued = {key, text: `qfg: delete secret ${key}`, verb}
  } else {
    const keyset = p.keyset
    const fingerprint = p.fingerprint
    const scope = p.scope
    if (typeof keyset !== 'string' || !KEYSET_NAME_RE.test(keyset)) bad('invalid keyset name')
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) bad('invalid fingerprint')
    if (scope !== undefined && (typeof scope !== 'string' || !SCOPE_RE.test(scope))) bad('invalid scope')
    issued = {
      fingerprint,
      key,
      keyset,
      scope: scope as string | undefined,
      text: `qfg: ${verb} secret ${key}${scope === undefined ? '' : ` (${scope})`} on ${keyset} ${fingerprint}`,
      verb: verb as 'create' | 'set',
    }
  }

  const message = Object.freeze({text: issued.text})
  ISSUED_MESSAGES.set(message, issued)
  return message
}

/** Turn the caller's changes into server deltas, with kind and beforeJson taken from the snapshot. */
function toDeltas(files: unknown, snapshot: PushWorkspaceFilesInput['snapshot']): ServerFileDelta[] {
  if (!Array.isArray(files) || files.length === 0) invalid('nothing to write')
  const seen = new Set<string>()
  return [...files].map((raw: WorkspaceFileChange) => {
    // Each member is read once: what is checked below is what is sent.
    const change =
      typeof raw === 'object' && raw !== null
        ? {afterJson: (raw as {afterJson?: unknown}).afterJson, delete: 'delete' in raw, path: raw.path}
        : invalid('a file change must be an object')
    const filePath = change.path
    if (typeof filePath !== 'string') invalid('a file change has no path')
    if (seen.has(filePath)) invalid(`${filePath} is listed twice`)
    seen.add(filePath)
    const match = SECRET_FILE_RE.exec(filePath)
    if (filePath !== QUONFIG_JSON) {
      if (!match) invalid(`${JSON.stringify(filePath)} is not secrets/<key>.json or quonfig.json`)
      try {
        if (secretPath(match![1]) !== filePath) invalid(`${filePath} is not a secret file name`)
      } catch (error) {
        if (error instanceof SecretDocumentError) invalid(`${filePath}: ${error.message}`)
        throw error
      }
    }

    const before = snapshot.readFile(filePath)
    if (change.delete) {
      if (filePath === QUONFIG_JSON) invalid('quonfig.json cannot be deleted')
      if (before === undefined) invalid(`cannot delete ${filePath}: the workspace does not have it`)
      return {beforeJson: before, kind: 'delete', path: filePath}
    }

    const afterJson = change.afterJson
    if (typeof afterJson !== 'string') invalid(`${filePath}: no content`)
    if (filePath === QUONFIG_JSON) {
      let manifest: unknown
      try {
        manifest = JSON.parse(afterJson)
      } catch {
        invalid('quonfig.json must be a JSON object')
      }

      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        invalid('quonfig.json must be a JSON object')
      }
    }

    if (match) {
      let doc: unknown
      try {
        doc = JSON.parse(afterJson)
      } catch {
        invalid(`${filePath} is not valid JSON`)
      }

      try {
        assertWritableSecretDocument(doc)
      } catch (error) {
        if (error instanceof SecretDocumentError) invalid(`${filePath}: ${error.message}`)
        throw error
      }

      if ((doc as {key: string}).key !== match[1]) invalid(`${filePath} holds another key`)
    }

    return before === undefined
      ? {afterJson, kind: 'add', path: filePath}
      : {afterJson, beforeJson: before, kind: 'modify', path: filePath}
  })
}

const KIND_FOR_VERB = {create: 'add', delete: 'delete', set: 'modify'} as const

const describe = (why: string): never => invalid(`the commit message does not describe this write: ${why}`)

/**
 * The write must be exactly the one file the message names, with the
 * matching kind; a create or set must carry a value on the message's keyset
 * and key fingerprint in the message's scope; a modify must change the file.
 */
function checkMessageMatches(issued: IssuedMessage, deltas: ServerFileDelta[]): void {
  const file = secretPath(issued.key)
  if (deltas.length !== 1 || deltas[0].path !== file) {
    describe(`it says ${issued.verb} ${file}; the write changes ${deltas.map((d) => d.path).join(', ')}`)
  }

  const delta = deltas[0]
  if (delta.kind !== KIND_FOR_VERB[issued.verb]) {
    describe(`it says ${issued.verb} ${file}, which the write changes as ${delta.kind}`)
  }

  if (issued.verb === 'delete') return
  if (delta.kind === 'modify' && delta.afterJson === delta.beforeJson) describe(`${file} would not change`)
  const doc = JSON.parse(delta.afterJson!) as {
    default?: {rules?: Array<{value?: {value?: unknown}}>}
    environments?: Array<{id?: string; rules?: Array<{value?: {value?: unknown}}>}>
  }
  const scope = issued.scope ?? 'default'
  const rules = scope === 'default' ? doc.default?.rules : doc.environments?.find((e) => e.id === scope)?.rules
  const wanted = `qf1:${issued.keyset}:${issued.fingerprint}:`
  const carried = (rules ?? []).some((r) => typeof r?.value?.value === 'string' && r.value.value.startsWith(wanted))
  if (!carried) describe(`${file} has no ${scope} value on ${issued.keyset} ${issued.fingerprint}`)
}

/**
 * Run the push hook's validator over the tree this commit would create (the
 * NEW quonfig.json when the write changes it) and refuse on errors this
 * write is responsible for: any error naming a written file; and, when the
 * write changes quonfig.json, any error on quonfig.json or on any secrets/
 * document (a keyset or public key removed while a secret still uses it).
 * Errors elsewhere in the workspace are left to the server's own hook.
 */
function preflight(input: PushWorkspaceFilesInput, deltas: ServerFileDelta[]): void {
  const files = input.snapshot.documents()
  let quonfigJson = input.snapshot.readFile(QUONFIG_JSON)
  for (const d of deltas) {
    if (d.path === QUONFIG_JSON) quonfigJson = d.afterJson
    else if (d.kind === 'delete') files.delete(d.path)
    else files.set(d.path, d.afterJson!)
  }

  const written = new Set(deltas.map((d) => d.path))
  const manifestChanged = written.has(QUONFIG_JSON)
  const ours = (file: string) =>
    written.has(file) || (manifestChanged && (file === QUONFIG_JSON || file.startsWith('secrets/')))
  const result = validateFileMap(files, {quonfigJson, validateValues: true})
  // A duplicate-key issue names every file of the group, comma-separated.
  const errors = result.issues.filter((i) => i.severity === 'error' && i.file.split(', ').some((f) => ours(f)))
  if (errors.length > 0) {
    throw new SecretWriteError(
      'refused',
      `the push hook would reject this write:\n${errors.map((i) => `  ${i.file}: ${i.message}`).join('\n')}`,
    )
  }
}

const MAX_DENIALS_SHOWN = 20

/** Server text made safe to show: no token-bearing URL, no bearer token, no qf1 value, bounded length. */
function scrub(text: string): string {
  return redactToken(text)
    .replaceAll(/bearer\s+\S+/gi, 'Bearer ***')
    .replaceAll(/qf1:[^\s"'\\]+/g, '[qf1 value]')
    .slice(0, 500)
}

/** What to say when the client cannot know whether the server applied the write. */
const unknownResult = (key: string) =>
  `the result is unknown: the write may or may not have been applied; check with \`qfg info ${key}\` (or the app) before retrying`

/**
 * callConfigsPush throws for outcomes it does not map; turn each into a
 * SecretWriteError that claims only what the client can know. Only an
 * answer that proves it (the mapped 400, 403 with denials, 409) says
 * "nothing was written"; a 2xx without a commit, a lost connection and any
 * other status leave the result unknown.
 */
function transportError(error: unknown, key: string): SecretWriteError {
  const raw = error instanceof Error ? error.message : String(error)
  const text = scrub(raw)
  if (/returned (HTTP )?2\d\d but no commitSha/.test(raw)) {
    return new SecretWriteError(
      'unknown_result',
      `the server answered ${/returned (?:HTTP )?(2\d\d)/.exec(raw)![1]} but returned no commit: ${unknownResult(key)}`,
    )
  }

  const status = Number(/\(HTTP (\d{3})\)/.exec(raw)?.[1] ?? Number.NaN)
  if (Number.isNaN(status)) {
    return new SecretWriteError(
      'unknown_result',
      `the connection to the server failed (${text}): ${unknownResult(key)}`,
    )
  }

  if (status === 401) {
    return new SecretWriteError('unauthorized', `the server did not accept this machine's credentials: ${text}`)
  }

  if (status === 403) return new SecretWriteError('denied', `the server refused the request (HTTP 403): ${text}`, [])
  if (status === 422) return new SecretWriteError('hook_rejected', `the workspace hook rejected the write: ${text}`)
  return new SecretWriteError(
    status >= 500 ? 'server_error' : 'unknown_result',
    `the server answered HTTP ${status}: ${unknownResult(key)} (${text})`,
  )
}

/** Commit the changes in one `configs.push`, locked to the snapshot's HEAD. Returns the new commit sha. */
export async function pushWorkspaceFiles(
  input: PushWorkspaceFilesInput,
  push?: (body: ConfigPushInput, orgSlug: string) => Promise<ConfigPushResult>,
): Promise<{commitSha: string}> {
  const expectedSha = input.snapshot.headSha
  if (typeof expectedSha !== 'string' || !SHA_RE.test(expectedSha)) {
    throw new SecretWriteError('invalid_input', 'the workspace snapshot has no HEAD sha to lock the write to')
  }

  // Read once: an accessor cannot hand the checks one value and the request another.
  const message: unknown = input.message
  const files: unknown = input.files
  const issued = typeof message === 'object' && message !== null ? ISSUED_MESSAGES.get(message) : undefined
  if (!issued) {
    throw new SecretWriteError('invalid_input', 'the commit message must come from secretCommitMessage')
  }

  let deltas: ServerFileDelta[]
  try {
    deltas = toDeltas(files, input.snapshot)
    checkMessageMatches(issued, deltas)
    preflight(input, deltas)
  } catch (error) {
    if (error instanceof SnapshotPathError) throw new SecretWriteError('invalid_input', error.message)
    throw error
  }

  const send = push ?? (await import('../push/config-push-client.js')).callConfigsPush
  let result: ConfigPushResult
  try {
    result = await send(
      {expectedSha, files: deltas, message: issued.text, workspaceId: input.workspaceId},
      input.orgSlug,
    )
  } catch (error) {
    throw transportError(error, issued.key)
  }

  switch (result.kind) {
    case 'success':
      return {commitSha: result.commitSha}
    case 'conflict': {
      const why = scrub(String(result.message ?? ''))
      throw new SecretWriteError(
        'conflict',
        /workspace head moved/i.test(why)
          ? 'the workspace changed while writing; nothing was written; run the command again'
          : `the server refused the write as a conflict (HTTP 409)${why ? `: ${why}` : ''}; nothing was written`,
      )
    }
    case 'denied': {
      const shown = result.denials.slice(0, MAX_DENIALS_SHOWN).map((d) => ({
        path: scrub(String(d.path)),
        reason: scrub(String(d.reason)),
        requiredPermission: scrub(String(d.requiredPermission)),
      }))
      const more = result.denials.length - shown.length
      const lines = shown.map((d) => `  ${d.path}: ${d.reason} (needs ${d.requiredPermission})`)
      if (more > 0) lines.push(`  ... and ${more} more`)
      // The error carries the same scrubbed, capped list it prints.
      throw new SecretWriteError('denied', `the server refused the write:\n${lines.join('\n')}`, shown)
    }

    default: {
      const message = scrub(String(result.message))
      throw new SecretWriteError(
        'bad_request',
        /push allow-list/i.test(message) && /secrets\//.test(message)
          ? `this Quonfig server does not accept secrets/ yet (${message})`
          : `the server refused the write (HTTP 400)${message ? `: ${message}` : ''}`,
      )
    }
  }
}
