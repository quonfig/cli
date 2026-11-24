/**
 * The secrets writer: commit `secrets/` files (and `quonfig.json`, for the
 * keyset commands of qfg-mol-5l7) in ONE commit through app-quonfig's
 * existing `configs.push` route, locked to the snapshot they were built from.
 * Bead qfg-mol-hle, plan section 0 and Q1.
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
 *     every written file (src/verify `validateFileMap`, as the hook calls it);
 *   - the commit message is built from validated names only
 *     (`secretCommitMessage`), so no plaintext, length or tail can reach it.
 * No plaintext and no private key exists anywhere on this path.
 */
import type {ConfigPushInput, ConfigPushResult, PushDenial, ServerFileDelta} from '../push/run-push.js'

import {KEYSET_NAME_RE, FINGERPRINT_RE} from './qf1.js'
import {SecretDocumentError, assertWritableSecretDocument, secretPath} from './secret-doc.js'
import type {WorkspaceSnapshot} from './workspace-snapshot.js'
import {validateFileMap} from '../verify/validate.js'

export type WorkspaceFileChange = {afterJson: string; path: string} | {delete: true; path: string}

/** A commit message, by its parts: only names and fingerprints, never a value. */
export type SecretCommitMessage = {readonly __secretCommitMessage: unique symbol} & string

export type PushWorkspaceFilesInput = {
  files: WorkspaceFileChange[]
  message: SecretCommitMessage
  orgSlug: string
  /** The snapshot the files were built from: its HEAD is the lock. */
  snapshot: Pick<WorkspaceSnapshot, 'documents' | 'headSha' | 'readFile'>
  workspaceId: string
}

export type SecretWriteErrorCode = 'bad_request' | 'conflict' | 'denied' | 'invalid_input' | 'refused'

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

/**
 * `qfg: create secret <key> on <KEYSET> <fp>`, `qfg: set secret <key> (<scope>)
 * on <KEYSET> <fp>`, `qfg: delete secret <key>`. Every part is validated
 * (key by the push hook's rules, keyset by spec 2, fingerprint by spec 4,
 * scope as an environment id), so nothing else can be carried in.
 */
export function secretCommitMessage(parts: CommitParts): SecretCommitMessage {
  try {
    secretPath(parts.key)
  } catch {
    bad('the key is not a valid secret key')
  }

  if (parts.verb === 'delete') return `qfg: delete secret ${parts.key}` as SecretCommitMessage
  if (typeof parts.keyset !== 'string' || !KEYSET_NAME_RE.test(parts.keyset)) bad('invalid keyset name')
  if (typeof parts.fingerprint !== 'string' || !FINGERPRINT_RE.test(parts.fingerprint)) bad('invalid fingerprint')
  if (parts.scope !== undefined && !SCOPE_RE.test(parts.scope)) bad('invalid scope')
  const scope = parts.scope === undefined ? '' : ` (${parts.scope})`
  return `qfg: ${parts.verb} secret ${parts.key}${scope} on ${parts.keyset} ${parts.fingerprint}` as SecretCommitMessage
}

/** Turn the caller's changes into server deltas, with kind and beforeJson taken from the snapshot. */
function toDeltas(input: PushWorkspaceFilesInput): ServerFileDelta[] {
  if (!Array.isArray(input.files) || input.files.length === 0) invalid('nothing to write')
  const seen = new Set<string>()
  return input.files.map((change) => {
    const filePath = change.path
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

    const before = input.snapshot.readFile(filePath)
    if ('delete' in change) {
      if (before === undefined) invalid(`cannot delete ${filePath}: the workspace does not have it`)
      return {beforeJson: before, kind: 'delete', path: filePath}
    }

    if (typeof change.afterJson !== 'string') invalid(`${filePath}: no content`)
    if (match) {
      let doc: unknown
      try {
        doc = JSON.parse(change.afterJson)
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
      ? {afterJson: change.afterJson, kind: 'add', path: filePath}
      : {afterJson: change.afterJson, beforeJson: before, kind: 'modify', path: filePath}
  })
}

/**
 * Run the push hook's validator over the tree this commit would create and
 * refuse on any error that names a written file. Issues elsewhere in the
 * workspace are not this write's business: the server's own hook decides.
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
  const result = validateFileMap(files, {quonfigJson, validateValues: true})
  // A duplicate-key issue names every file of the group, comma-separated.
  const errors = result.issues.filter(
    (i) => i.severity === 'error' && i.file.split(', ').some((file) => written.has(file)),
  )
  if (errors.length > 0) {
    throw new SecretWriteError(
      'refused',
      `the push hook would reject this write:\n${errors.map((i) => `  ${i.file}: ${i.message}`).join('\n')}`,
    )
  }
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

  const deltas = toDeltas(input)
  preflight(input, deltas)

  const send = push ?? (await import('../push/config-push-client.js')).callConfigsPush
  const result = await send(
    {expectedSha, files: deltas, message: input.message, workspaceId: input.workspaceId},
    input.orgSlug,
  )
  switch (result.kind) {
    case 'success':
      return {commitSha: result.commitSha}
    case 'conflict':
      throw new SecretWriteError(
        'conflict',
        'the workspace changed while writing; nothing was written; run the command again',
      )
    case 'denied':
      throw new SecretWriteError(
        'denied',
        `the server refused the write:\n${result.denials
          .map((d) => `  ${d.path}: ${d.reason} (needs ${d.requiredPermission})`)
          .join('\n')}`,
        result.denials,
      )
    default:
      throw new SecretWriteError(
        'bad_request',
        /push allow-list/i.test(result.message) && /secrets\//.test(result.message)
          ? `this Quonfig server does not accept secrets/ yet (${result.message})`
          : `the server refused the write: ${result.message}`,
      )
  }
}
