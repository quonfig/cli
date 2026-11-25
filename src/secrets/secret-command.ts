/**
 * The command side of a secret write (qfg create --secret, qfg set-default on
 * a secret): the workspace snapshot, the default access tier, the push, and
 * every message a user sees. Bead qfg-mol-hle PR 3. No message here carries
 * a plaintext: the commands hand in only keys, keyset names, fingerprints and
 * the redacted summary.
 */
import type {APICommand} from '../index.js'
import type {JsonObj} from '../result.js'
import type {KeysetChoice} from './choose-keyset.js'
import type {SecretWritePlan} from './secret-write-flow.js'

import {redactedDisplay} from '../util/redact.js'
import {KeysetChoiceError} from './choose-keyset.js'
import {Qf1Error} from './qf1.js'
import {SecretDocumentError} from './secret-doc.js'
import {SecretRefusal} from './secret-write-flow.js'
import {localKeysetStatus} from './workspace-keysets.js'
import {defaultSnapshotDeps, openWorkspaceSnapshot, type WorkspaceSnapshot} from './workspace-snapshot.js'
import {SecretWriteError, pushWorkspaceFiles} from './write-secret.js'

/** The docs page that lists the backend SDK versions that read secrets (spec 13.4, decision 26). */
export const SECRETS_DOCS_URL = 'https://docs.quonfig.com/docs/explanations/features/secret-management'

export const VALUE_ARGV_WARNING =
  'Warning: --value puts the secret in argv and shell history; prefer --value-stdin or --value-from-env.'

export const SECRET_KEY_NAME_ERROR =
  'qf1 secrets are encrypted to a keyset from quonfig.json; --secret-key-name no longer applies. Use --keyset.'

export const PROPOSE_SECRET_ERROR =
  'Change requests cannot carry secrets yet; write it directly with qfg set-default --secret (without --propose / --cr).'

/** Spec 13.4: printed once, after the success line, when a write creates a workspace's first secret. */
export const firstSecretNotice = (workspace: string): string =>
  `This is the first secret in ${workspace}. Backend SDKs read secrets only from a minimum version; ` +
  `an older SDK returns the encrypted text as the value. Versions: ${SECRETS_DOCS_URL}`

/** Q9: a key in both configs/ (old copy) and secrets/ was updated in secrets/ only. */
export const twinNotice = (twin: string): string =>
  `Note: ${twin} (old format, read by SDKs older than the minimum version) was not changed.`

/** `[encrypted *****3fa9c, 51 chars, ends …a1b2] on QUONFIG_KEYSET_PROD (key 9c1e2f3a)` */
export const encryptedPhrase = (plan: SecretWritePlan): string =>
  `${redactedDisplay(plan.redacted)} on ${plan.choice.keyset} (key ${plan.choice.fingerprint})`

/**
 * Whether this machine can read values on the keyset just written (stderr,
 * after success; plan 3.1). Names and fingerprints only, never env content.
 */
export function readabilityNote(
  choice: KeysetChoice,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const local = localKeysetStatus(choice.keyset, choice.fingerprint, env)
  const expected = 'That is expected: writing needs no private key.'
  switch (local.status) {
    case 'reads-write-key':
      return undefined
    case 'holds-other-keys':
      return `This machine has ${choice.keyset} but not key ${choice.fingerprint}, so it cannot read this value. ${expected}`
    case 'invalid':
      return `${choice.keyset} on this machine is unreadable${local.entry === undefined ? '' : ` (entry ${local.entry})`}, so it cannot read this value. ${expected}`
    default:
      return `This machine cannot read ${choice.keyset} values (no ${choice.keyset} here). ${expected}`
  }
}

/** The redacted value with the keyset and its write key, for --json. Never the value. */
export const jsonValue = (plan: SecretWritePlan): JsonObj => ({
  ...plan.redacted,
  keyFingerprint: plan.choice.fingerprint,
  keyset: plan.choice.keyset,
})

const ACCESS_TIERS: ReadonlySet<string> = new Set(['protected-all-envs', 'protected-env', 'standard', 'support'])

/** A failure before anything was written, with the text to show. */
export class SecretCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretCommandError'
  }
}

/**
 * The access tier a NEW item gets in this workspace: app-quonfig's
 * `environments.getDefaultCreateAccess` (readable by any member; null means
 * unset = standard). A failed lookup fails the create, as the server's own
 * create does: a secret is never created at a guessed tier.
 */
export async function defaultCreateAccess(command: APICommand): Promise<string> {
  const request = await command.apiClient.post('/api/v1/environments/getDefaultCreateAccess', {
    workspaceId: command.workspaceId,
  })
  if (!request.ok) {
    throw new SecretCommandError(
      `could not read the workspace's default access tier for new items (HTTP ${request.status}); nothing was written`,
    )
  }

  const tier = (request.json as {defaultCreateAccess?: unknown} | undefined)?.defaultCreateAccess
  if (tier === null || tier === undefined) return 'standard'
  if (typeof tier !== 'string' || !ACCESS_TIERS.has(tier)) {
    throw new SecretCommandError(
      'the server returned an access tier this qfg does not know for new items; nothing was written. Update qfg.',
    )
  }

  return tier
}

/** Snapshot the workspace the command targets, refusing a snapshot of any other workspace. */
export async function openCommandSnapshot(
  command: APICommand,
  workspace: string | undefined,
): Promise<{orgSlug: string; snapshot: WorkspaceSnapshot; workspaceId: string}> {
  const opened = await openWorkspaceSnapshot(workspace, await defaultSnapshotDeps(command))
  if (command.workspaceId && opened.workspaceId !== command.workspaceId) {
    await opened.snapshot.cleanup()
    throw new SecretCommandError(
      `the workspace snapshot is of ${opened.workspaceId}, not the target workspace ${command.workspaceId}; nothing was written`,
    )
  }

  return opened
}

/** The text for a writer failure. A tier denial is reported as it is: never retried at another tier. */
export function writeErrorMessage(error: SecretWriteError): string {
  if (error.code === 'bad_request' && /does not accept secrets\/ yet/.test(error.message)) {
    return (
      'this Quonfig server does not support secrets/ yet, so nothing was written. ' +
      'Secrets need a newer Quonfig server; try again once it is updated. ' +
      `(${error.message})`
    )
  }

  if (error.code === 'denied') {
    return `you do not have permission to write this secret; nothing was written. ${error.message}`
  }

  return error.message
}

/**
 * The text for a failed secret write, or undefined for an error this module
 * does not know (the caller rethrows it). Every known failure names keys,
 * keysets, fingerprints and reasons only, never a value.
 */
export function knownSecretFailure(error: unknown): string | undefined {
  if (error instanceof SecretWriteError) return writeErrorMessage(error)
  if (
    error instanceof SecretRefusal ||
    error instanceof SecretCommandError ||
    error instanceof KeysetChoiceError ||
    error instanceof SecretDocumentError ||
    error instanceof Qf1Error
  ) {
    return error.message
  }

  return undefined
}

/** Push the plan's files in one commit, locked to the snapshot. Returns the new commit sha. */
export async function pushPlan(
  plan: SecretWritePlan,
  target: {orgSlug: string; snapshot: WorkspaceSnapshot; workspaceId: string},
): Promise<string> {
  const {commitSha} = await pushWorkspaceFiles({
    files: plan.files,
    message: plan.message,
    orgSlug: target.orgSlug,
    snapshot: target.snapshot,
    workspaceId: target.workspaceId,
  })
  return commitSha
}

export {SecretWriteError} from './write-secret.js'
