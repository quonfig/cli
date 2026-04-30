import {Args, Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getApiUrl} from '../../util/domain-urls.js'
import {getValidAccessToken, resolveDefaultOrgId} from '../../util/get-valid-token.js'

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

    // Resolve auth via the same path every other command uses. We
    // don't require an active-workspace profile (AuthConfig) — the
    // whole point of this command is to create one — but we do need a
    // valid bearer token / API key.
    let accessToken: string
    try {
      // TODO(qfg-kr7.7): once --org is required for multi-org users, resolve the
      // orgId from --org first and pass it here. Today we use the default org.
      const orgId = await resolveDefaultOrgId()
      accessToken = await getValidAccessToken(orgId)
    } catch {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const apiUrl = getApiUrl()
    const body: Record<string, string> = {slug}
    if (flags.name) body.name = flags.name
    if (flags.org) {
      // Accept either a UUID (from the API) or a human-readable slug.
      // The server resolves the slug to the local org UUID.
      const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
      if (uuidPattern.test(flags.org)) {
        body.organizationId = flags.org
      } else {
        body.organizationSlug = flags.org
      }
    }

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
