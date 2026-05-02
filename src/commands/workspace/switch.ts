import {Args} from '@oclif/core'
import {select} from '@inquirer/prompts'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getApiUrl} from '../../util/domain-urls.js'
import {getValidAccessToken} from '../../util/get-valid-token.js'
import {tryParseWorkspacePin} from '../../util/quonfig-json.js'
import {findOrgIdBySlug, loadAuthConfig, loadTokens, saveAuthConfig} from '../../util/token-storage.js'

const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

type WorkspaceEntry = {
  workspaceId: string
  workspaceSlug: string
  workosOrgId: string
  organizationName: string
  organizationSlug?: string
}

export default class WorkspaceSwitch extends BaseCommand {
  static args = {
    slug: Args.string({
      description: 'Workspace pin in `<org-slug>/<workspace-slug>` form. Omit for an interactive picker.',
      required: false,
    }),
  }

  static description = 'Switch the saved default profile to a different (org, workspace) pair'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> acme/production']

  public async run(): Promise<JsonObj | void> {
    const {args} = await this.parse(WorkspaceSwitch)

    const store = await loadTokens()
    if (!store || Object.keys(store.tokensByOrg).length === 0) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    // /userWorkspaces/list is per-token-org-scoped — a single org's JWT
    // only sees that org's workspaces. To support multi-org pickers we
    // must iterate every cached org and merge.
    const candidates = await this.fetchAllOrgsWorkspaces(store)
    if (candidates.length === 0) {
      return this.err('No workspaces found for your account.')
    }

    let match: WorkspaceEntry
    if (args.slug) {
      const found = this.matchByArg(args.slug, candidates, store)
      if ('error' in found) return this.err(found.error)
      match = found.match
    } else if (candidates.length === 1) {
      match = candidates[0]
      const pin = pinFor(match)
      this.log(`Only one workspace available: ${pin}`)
    } else {
      const chosen = await select({
        choices: candidates.map((w) => ({name: pinFor(w), value: w.workspaceId})),
        message: 'Select workspace:',
      })
      const found = candidates.find((w) => w.workspaceId === chosen)
      if (!found) return this.err('No workspace selected.')
      match = found
    }

    const authConfig = (await loadAuthConfig()) ?? {profiles: {}, defaultProfile: 'default'}
    const defaultProfile = authConfig.defaultProfile || 'default'
    const orgSlug = match.organizationSlug ?? slugFromName(match.organizationName) ?? match.workosOrgId
    await saveAuthConfig({
      ...authConfig,
      defaultProfile,
      profiles: {
        ...authConfig.profiles,
        [defaultProfile]: {
          workspace: match.workspaceId,
          workspaceName: match.workspaceSlug,
          workspaceSlug: match.workspaceSlug,
          organizationName: match.organizationName,
          organizationSlug: orgSlug,
        },
      },
    })

    const pin = `${orgSlug}/${match.workspaceSlug}`
    this.log(`\nSwitched to: ${pin}`)
    this.log(`\nTo use this workspace in a project, add to your .env:`)
    this.log(`  QUONFIG_WORKSPACE=${pin}`)

    return {
      success: true,
      activeWorkspace: pin,
      organizationName: match.organizationName,
      organizationSlug: orgSlug,
      workspaceId: match.workspaceId,
      workspaceSlug: match.workspaceSlug,
    }
  }

  /**
   * Resolve the user's positional arg against the candidate list.
   *
   * - `org/ws` form (preferred) → match by both org slug and workspace slug.
   * - UUID → workspaceId match (kept for back-compat with scripts that
   *   pass IDs straight through). Bare slug is rejected with the same
   *   migration message used elsewhere in the CLI.
   */
  private matchByArg(
    arg: string,
    candidates: WorkspaceEntry[],
    store: NonNullable<Awaited<ReturnType<typeof loadTokens>>>,
  ): {match: WorkspaceEntry} | {error: string} {
    if (UUID_PATTERN.test(arg)) {
      const found = candidates.find((w) => w.workspaceId === arg)
      if (!found) return {error: `Workspace UUID "${arg}" not found among your accessible workspaces.`}
      return {match: found}
    }

    const pin = tryParseWorkspacePin(arg)
    if (!pin) {
      return {
        error:
          'Workspace argument must be in `<org-slug>/<workspace-slug>` form (e.g. acme/production). ' +
          'Bare workspace slugs are no longer accepted.',
      }
    }

    const orgId = findOrgIdBySlug(store, pin.orgSlug)
    if (!orgId) {
      return {error: `No token found for org \`${pin.orgSlug}\`. Run \`qfg login\` to add this org.`}
    }

    const found = candidates.find((w) => w.workosOrgId === orgId && w.workspaceSlug === pin.workspaceSlug)
    if (!found) {
      const inOrg = candidates.filter((w) => w.workosOrgId === orgId).map((w) => w.workspaceSlug)
      const available = inOrg.length > 0 ? inOrg.join(', ') : '(none)'
      return {
        error: `Workspace "${pin.workspaceSlug}" not found in org "${pin.orgSlug}". Available: ${available}.`,
      }
    }

    return {match: found}
  }

  /**
   * Iterate every cached org and merge its workspace list. Each org has its
   * own access token; one token only sees one org's workspaces. We tolerate
   * a single org's failure (verbose-log it) so a stale token in one org
   * doesn't block switching into a working one.
   */
  private async fetchAllOrgsWorkspaces(
    store: NonNullable<Awaited<ReturnType<typeof loadTokens>>>,
  ): Promise<WorkspaceEntry[]> {
    const merged = new Map<string, WorkspaceEntry>()
    for (const orgId of Object.keys(store.tokensByOrg)) {
      let token: string
      try {
        // eslint-disable-next-line no-await-in-loop
        token = await getValidAccessToken(orgId, this.verboseLog)
      } catch (error) {
        this.verboseLog('workspace switch: token refresh failed', {orgId, error: String(error)})
        continue
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({json: {}}),
        })

        if (!res.ok) {
          this.verboseLog('workspace switch: list returned non-OK', {orgId, status: res.status})
          continue
        }

        // eslint-disable-next-line no-await-in-loop
        const body = (await res.json()) as {json?: WorkspaceEntry[]}
        const list = (body.json ?? body) as unknown as WorkspaceEntry[]
        if (!Array.isArray(list)) continue
        for (const w of list) {
          merged.set(w.workspaceId, w)
        }
      } catch (error) {
        this.verboseLog('workspace switch: fetch failed', {orgId, error: String(error)})
      }
    }

    return [...merged.values()]
  }
}

function pinFor(w: WorkspaceEntry): string {
  const orgSlug = w.organizationSlug ?? slugFromName(w.organizationName) ?? w.workosOrgId
  return `${orgSlug}/${w.workspaceSlug}`
}

function slugFromName(name: string | undefined): string | undefined {
  if (!name) return undefined
  return name
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}
