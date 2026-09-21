/**
 * What `qfg workspace bootstrap` tells the user about the workspace it is
 * about to push to, and the one check that stops it landing content in the
 * wrong place.
 *
 * The target is resolved the same way `qfg push` / `qfg pull` / `qfg sync`
 * resolve theirs: `QUONFIG_WORKSPACE`, then the directory's `quonfig.json`
 * pin, then the active profile. The prompt must name whichever of those won;
 * naming the profile when the env var chose another workspace is how a
 * customer confirms a push to the wrong place (qfg-8p8i).
 */

import type {WorkspacePin} from './quonfig-json.js'

export interface BootstrapProfile {
  organizationSlug?: string
  workspace: string
  workspaceName?: string
  workspaceSlug?: string
}

export interface BootstrapTargetInput {
  /** `QUONFIG_WORKSPACE`, when set: it outranks everything else. */
  envOverride: string | undefined
  /** The `--dir` directory's `quonfig.json` pin, when readable. */
  pin: WorkspacePin | undefined
  /** The active profile, if any. Only trusted when it IS the resolved workspace. */
  profile: BootstrapProfile | undefined
  /** What the resolver actually returned. */
  workspaceId: string
}

/** The pin form of a workspace, `<org>/<workspace>`. */
const pinForm = (pin: WorkspacePin): string => `${pin.orgSlug}/${pin.workspaceSlug}`

/**
 * The name to show for the resolved workspace, from whichever source chose
 * it. Falls back to the id rather than to a profile that points elsewhere.
 */
export const describeBootstrapTarget = (input: BootstrapTargetInput): string => {
  if (input.envOverride) return input.envOverride
  if (input.pin) return pinForm(input.pin)
  const {profile} = input
  if (profile && profile.workspace === input.workspaceId) {
    if (profile.workspaceSlug) {
      return profile.organizationSlug ? `${profile.organizationSlug}/${profile.workspaceSlug}` : profile.workspaceSlug
    }

    if (profile.workspaceName) return profile.workspaceName
  }

  return input.workspaceId
}

/**
 * `qfg push`'s Guard 1 for bootstrap: a directory pinned to one workspace is
 * not pushed to another. Compares the workspace component only, as push does
 * (backend responses do not carry the org slug yet). Returns the refusal
 * message, or nothing when there is no pin or it matches.
 */
export const bootstrapPinMismatch = (
  pin: WorkspacePin | undefined,
  backendWorkspaceSlug: string,
): string | undefined => {
  if (!pin || pin.workspaceSlug === backendWorkspaceSlug) return undefined
  return (
    `This directory's quonfig.json is pinned to workspace "${pinForm(pin)}", ` +
    `but the target workspace is "${backendWorkspaceSlug}".\n` +
    `Nothing was pushed. Unset QUONFIG_WORKSPACE to bootstrap the pinned workspace, ` +
    `or change the pin in quonfig.json if "${backendWorkspaceSlug}" is really the target.`
  )
}
