import {Args, Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getApiUrl} from '../../util/domain-urls.js'
import {getValidAccessToken} from '../../util/get-valid-token.js'
import {findOrgIdBySlug, loadTokens} from '../../util/token-storage.js'

const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

/**
 * Slugify matches the UI's rules exactly (see
 * app-quonfig/src/app/(app)/workspaces/new/page.tsx): lowercase, any
 * non-alphanumeric run → single hyphen, strip leading/trailing hyphens.
 * The server re-runs this for safety, but we run it here so the user
 * sees the canonical slug in confirmation output.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

type CreateResponse = {
  workspaceId: string
  workspaceSlug: string
  organizationSlug?: string
  gitRepoUrl: string
  gitRepoFullName?: string | null
  environments: Array<{id: string; name: string; environmentType: string}>
}

export default class WorkspaceCreate extends BaseCommand {
  static args = {
    slug: Args.string({
      description: 'Workspace slug (lowercase letters, numbers, hyphens)',
      required: true,
    }),
  }

  static description =
    "Create a new workspace. Provisions the Gitea repo and default environments, identical to the app's New Workspace UI."

  static examples = [
    '<%= config.bin %> <%= command.id %> my-team',
    '<%= config.bin %> <%= command.id %> lt-21-smoke --name "Load Test 21"',
    '<%= config.bin %> <%= command.id %> my-team --org 11111111-1111-1111-1111-111111111111',
  ]

  static flags = {
    name: Flags.string({
      description: 'Human-readable display name (defaults to the slug)',
      required: false,
    }),
    org: Flags.string({
      description:
        'Organization UUID or slug. Required when you belong to more than one organization; inferred otherwise.',
      required: false,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(WorkspaceCreate)

    const slug = slugify(args.slug)
    if (!slug) {
      return this.err(`"${args.slug}" does not produce a valid slug. Use letters, numbers, or hyphens.`)
    }

    // workspace create has no workspace context to lean on, so it can't go
    // through the org/ws resolver. Pick the org directly from the token
    // store: 1 org → auto, 2+ orgs → require --org, 0 orgs → not logged in.
    const orgResolution = await this.resolveOrgFromTokens(flags.org)
    if ('error' in orgResolution) return this.err(orgResolution.error)
    const {workosOrgId, orgSlug} = orgResolution

    let accessToken: string
    try {
      accessToken = await getValidAccessToken(workosOrgId)
    } catch {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const apiUrl = getApiUrl()
    // The server expects organizationSlug (it resolves to the local org
    // UUID) — not the WorkOS org id, which is what we have keyed in the
    // token store. resolveOrgFromTokens guarantees orgSlug is populated.
    const body: Record<string, string> = {slug, organizationSlug: orgSlug}
    if (flags.name) body.name = flags.name
    this.log(`Creating workspace in org: ${orgSlug}`)

    this.verboseLog('WorkspaceCreate', {apiUrl, body})

    let res: Response
    try {
      res = await fetch(`${apiUrl}/api/v1/workspaces/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({json: body}),
      })
    } catch (error) {
      return this.err(`Request failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (res.status === 401 || res.status === 403) {
      return this.err(`Authentication/authorization failed (HTTP ${res.status}). Run \`qfg login\` to re-authenticate.`)
    }

    if (res.status === 409) {
      const detail = await this.extractErrorMessage(res)
      // Prefer the server's message when present (already clear); fall
      // back to a generated hint otherwise.
      return this.err(detail || `Workspace "${slug}" already exists. Pick a different slug (e.g. ${slug}-2).`)
    }

    if (res.status === 400) {
      const detail = await this.extractErrorMessage(res)
      if (detail.includes('more than one organization')) {
        return this.err(`${detail} Re-run with --org <uuid>. You can list available orgs from the app UI.`)
      }
      return this.err(`Bad request (HTTP 400): ${detail}`)
    }

    if (!res.ok) {
      const detail = await this.extractErrorMessage(res)
      return this.err(`Workspace creation failed (HTTP ${res.status}): ${detail}`)
    }

    const payload = (await res.json()) as {json?: CreateResponse}
    const created = (payload.json ?? (payload as unknown as CreateResponse)) as CreateResponse | undefined
    if (!created?.workspaceId) {
      return this.err('Unexpected response from server — no workspaceId returned.')
    }

    this.log('')
    this.log(`Workspace created.`)
    this.log(`  ID:          ${created.workspaceId}`)
    this.log(`  Slug:        ${created.workspaceSlug}`)
    if (created.organizationSlug) {
      this.log(`  Org:         ${created.organizationSlug}`)
    }
    this.log(`  Git repo:    ${created.gitRepoUrl}`)
    if (created.gitRepoFullName) {
      this.log(`  Gitea:       ${created.gitRepoFullName}`)
    }
    this.log(`  Envs:        ${created.environments.map((e) => e.name).join(', ')}`)
    this.log('')
    this.log(`To use this workspace locally:`)
    this.log(`  qfg workspace switch ${created.workspaceSlug}`)

    return {
      workspaceId: created.workspaceId,
      workspaceSlug: created.workspaceSlug,
      organizationSlug: created.organizationSlug,
      gitRepoUrl: created.gitRepoUrl,
      gitRepoFullName: created.gitRepoFullName ?? null,
      environments: created.environments,
    }
  }

  /**
   * Pick the org for the new workspace from the per-org token store.
   *
   * - 0 orgs → "No orgs found. Run `qfg login` first."
   * - 1 org → auto-select that org.
   * - 2+ orgs → require `--org <slug-or-uuid>`. Slug is matched against
   *   `org_slug` in the token store; UUID is matched against the token
   *   store key. Either way the org must exist locally — we never invent
   *   an orgId we don't have a token for.
   *
   * Always returns BOTH the WorkOS org id (needed to mint the JWT) and the
   * org slug (needed for the create-workspace request body). If the token
   * lacks `org_slug`, errors with a `qfg login` hint.
   */
  private async resolveOrgFromTokens(
    flagOrg: string | undefined,
  ): Promise<{workosOrgId: string; orgSlug: string} | {error: string}> {
    const store = await loadTokens()
    if (!store || Object.keys(store.tokensByOrg).length === 0) {
      return {error: 'No orgs found. Run `qfg login` first.'}
    }

    const entries = Object.entries(store.tokensByOrg)

    const requireSlug = (workosOrgId: string, orgSlug: string | undefined): {workosOrgId: string; orgSlug: string} | {error: string} => {
      if (!orgSlug) {
        return {error: `Org \`${workosOrgId}\` is missing its slug locally. Run \`qfg login\` to refresh your org list.`}
      }
      return {workosOrgId, orgSlug}
    }

    if (flagOrg) {
      if (UUID_PATTERN.test(flagOrg)) {
        const tokens = store.tokensByOrg[flagOrg]
        if (!tokens) {
          return {error: `Org \`${flagOrg}\` not found in your token store. Run \`qfg login\` to refresh your org list.`}
        }

        return requireSlug(flagOrg, tokens.org_slug)
      }

      const matchedId = findOrgIdBySlug(store, flagOrg)
      if (!matchedId) {
        return {error: `Org \`${flagOrg}\` not found in your token store. Run \`qfg login\` to refresh your org list.`}
      }

      return {workosOrgId: matchedId, orgSlug: flagOrg}
    }

    if (entries.length === 1) {
      const [orgId, tokens] = entries[0]
      return requireSlug(orgId, tokens.org_slug)
    }

    const slugList = entries
      .map(([, tokens]) => tokens.org_slug)
      .filter((s): s is string => Boolean(s))
      .join(', ')
    const orgList = slugList || entries.map(([orgId]) => orgId).join(', ')
    return {
      error: `You are a member of multiple orgs. Specify --org <org-slug> to indicate which org to create the workspace in. Your orgs: ${orgList}.`,
    }
  }

  /**
   * oRPC surfaces structured errors as {json: {code, message, ...}} or
   * {error: {...}}. Extract the message for display; fall back to raw
   * text when the body isn't JSON.
   */
  private async extractErrorMessage(res: Response): Promise<string> {
    try {
      const body = (await res.clone().json()) as {
        json?: {message?: string; code?: string}
        error?: {message?: string; code?: string}
        message?: string
      }
      return body.json?.message || body.error?.message || body.message || ''
    } catch {
      try {
        return await res.text()
      } catch {
        return ''
      }
    }
  }
}
