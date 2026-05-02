import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getApiUrl} from '../util/domain-urls.js'
import {getValidAccessToken} from '../util/get-valid-token.js'
import {tryParseWorkspacePin} from '../util/quonfig-json.js'
import {findOrgIdBySlug, getActiveProfile, loadAuthConfig, loadTokens} from '../util/token-storage.js'

const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

type WorkspaceEntry = {
  workspaceId: string
  workspaceSlug: string
  workosOrgId: string
  organizationSlug?: string
  organizationName?: string
}

export default class Workspace extends BaseCommand {
  static description = 'Show the active workspace, all org tokens, and every (org, workspace) the user can reach'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    if (process.env.QUONFIG_API_KEY) {
      return this.runApiKeyMode()
    }

    const store = await loadTokens()
    if (!store || Object.keys(store.tokensByOrg).length === 0) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const authConfig = await loadAuthConfig()

    const orgEntries = Object.entries(store.tokensByOrg)
    const orgSlugsWithTokens = orgEntries
      .map(([orgId, t]) => t.org_slug ?? orgId)
      .sort((a, b) => a.localeCompare(b))

    // /userWorkspaces/list is per-token-org-scoped — a single org's JWT
    // only sees that org's workspaces. Iterate every cached org so the
    // listing is comprehensive in multi-org accounts.
    const allWorkspaces = await this.fetchAllOrgsWorkspaces(orgEntries)

    const defaultProfilePin = this.profilePin(authConfig, allWorkspaces)
    const activePin = this.activePin(store, authConfig, allWorkspaces, defaultProfilePin)

    this.log(`Active workspace: ${activePin ?? '(none)'}`)
    this.log(`Default profile:  ${defaultProfilePin ?? '(none)'}`)
    this.log(`Orgs with tokens: ${orgSlugsWithTokens.length > 0 ? orgSlugsWithTokens.join(', ') : '(none)'}`)
    this.log('')
    this.log('All token-minted orgs and workspaces:')

    const grouped = groupByOrg(orgEntries, allWorkspaces)
    if (grouped.length === 0) {
      this.log('  (no workspaces visible — run `qfg login` to refresh)')
    } else {
      for (const group of grouped) {
        this.log(`  ${group.orgSlug}:`)
        if (group.workspaces.length === 0) {
          this.log('    (no workspaces yet — `qfg workspace create` to add one)')
          continue
        }

        for (const w of group.workspaces) {
          const pin = `${group.orgSlug}/${w.workspaceSlug}`
          const marker = pin === defaultProfilePin ? ' (default)' : ''
          this.log(`    - ${pin}${marker}`)
        }
      }
    }

    const totalWorkspaces = grouped.reduce((sum, g) => sum + g.workspaces.length, 0)
    if (totalWorkspaces > 1) {
      this.log('')
      this.log('To switch the default workspace: qfg workspace switch')
    }

    return {
      activeWorkspace: activePin,
      defaultProfile: defaultProfilePin,
      orgsWithTokens: orgSlugsWithTokens,
      orgs: grouped.map((g) => ({
        orgSlug: g.orgSlug,
        workosOrgId: g.workosOrgId,
        workspaces: g.workspaces.map((w) => ({
          workspaceId: w.workspaceId,
          workspaceSlug: w.workspaceSlug,
          pin: `${g.orgSlug}/${w.workspaceSlug}`,
        })),
      })),
    }
  }

  /**
   * Pin the default-profile workspaceId to org/ws form by looking it up in
   * the workspaces list. Returns undefined if the auth config is empty or
   * the saved workspace doesn't appear in the listing.
   */
  private profilePin(
    authConfig: Awaited<ReturnType<typeof loadAuthConfig>>,
    allWorkspaces: WorkspaceEntry[],
  ): string | undefined {
    if (!authConfig) return undefined
    const activeProfileName = getActiveProfile()
    const profile =
      authConfig.profiles[activeProfileName] || authConfig.profiles[authConfig.defaultProfile || 'default']
    if (!profile) return undefined

    const match = allWorkspaces.find((w) => w.workspaceId === profile.workspace)
    if (!match) return undefined
    const orgSlug = match.organizationSlug ?? slugFromName(match.organizationName)
    if (!orgSlug) return undefined
    return `${orgSlug}/${match.workspaceSlug}`
  }

  /**
   * QUONFIG_WORKSPACE wins over the default profile (matches the resolution
   * order in get-client.ts/resolve-workspace.ts). Bare slugs are ignored
   * here — the status command does NOT throw on a stale env-var, just
   * shows the default profile instead.
   */
  private activePin(
    store: NonNullable<Awaited<ReturnType<typeof loadTokens>>>,
    _authConfig: Awaited<ReturnType<typeof loadAuthConfig>>,
    allWorkspaces: WorkspaceEntry[],
    fallback: string | undefined,
  ): string | undefined {
    const env = process.env.QUONFIG_WORKSPACE
    if (env) {
      const pin = tryParseWorkspacePin(env)
      if (pin) {
        const orgId = findOrgIdBySlug(store, pin.orgSlug)
        if (orgId) {
          const match = allWorkspaces.find(
            (w) => w.workosOrgId === orgId && w.workspaceSlug === pin.workspaceSlug,
          )
          if (match) return `${pin.orgSlug}/${pin.workspaceSlug}`
        }
      }
    }

    return fallback
  }

  private async fetchWorkspaces(jwt: string): Promise<WorkspaceEntry[]> {
    try {
      const res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({json: {}}),
      })
      if (!res.ok) {
        this.verboseLog('workspace: userWorkspaces/list non-OK', {status: res.status})
        return []
      }

      const body = (await res.json()) as {json?: WorkspaceEntry[]}
      const list = (body.json ?? body) as unknown as WorkspaceEntry[]
      return Array.isArray(list) ? list : []
    } catch (error) {
      this.verboseLog('workspace: userWorkspaces/list failed', {error: String(error)})
      return []
    }
  }

  /**
   * Fan out across every cached org's token and merge the results. One org's
   * stale token doesn't block the others — we verbose-log and continue.
   */
  private async fetchAllOrgsWorkspaces(
    orgEntries: [string, unknown][],
  ): Promise<WorkspaceEntry[]> {
    const merged = new Map<string, WorkspaceEntry>()
    for (const [orgId] of orgEntries) {
      let jwt: string
      try {
        // eslint-disable-next-line no-await-in-loop
        jwt = await getValidAccessToken(orgId, this.verboseLog)
      } catch (error) {
        this.verboseLog('workspace: token refresh failed for org', {orgId, error: String(error)})
        continue
      }

      // eslint-disable-next-line no-await-in-loop
      const list = await this.fetchWorkspaces(jwt)
      for (const w of list) {
        merged.set(w.workspaceId, w)
      }
    }

    return [...merged.values()]
  }

  private async runApiKeyMode(): Promise<JsonObj | void> {
    const override = process.env.QUONFIG_WORKSPACE
    if (!override) {
      return this.err(
        'QUONFIG_API_KEY is set but QUONFIG_WORKSPACE is not. Set QUONFIG_WORKSPACE=<workspace-slug> (UUIDs also work).',
      )
    }

    let jwt: string
    try {
      jwt = await getValidAccessToken('')
    } catch (error) {
      return this.err(error instanceof Error ? error.message : String(error))
    }

    const entries = await this.fetchWorkspaces(jwt)
    if (entries.length === 0) {
      return this.err(`Failed to resolve workspace "${override}" — no entries returned.`)
    }

    const match = UUID_PATTERN.test(override)
      ? entries.find((w) => w.workspaceId === override)
      : entries.find((w) => w.workspaceSlug === override)

    if (!match) {
      const available = entries.map((w) => w.workspaceSlug).join(', ') || '(none)'
      return this.err(`Workspace "${override}" not accessible with this API key. Available: ${available}.`)
    }

    const orgSlug = match.organizationSlug ?? slugFromName(match.organizationName) ?? '(unknown-org)'
    const pin = `${orgSlug}/${match.workspaceSlug}`
    this.log(`Active workspace: ${pin}  (API key mode)`)
    this.log(`ID:               ${match.workspaceId}`)
    this.log(`Source:           QUONFIG_API_KEY + QUONFIG_WORKSPACE=${override}`)

    return {
      activeWorkspace: pin,
      organizationName: match.organizationName,
      workspace: match.workspaceId,
      workspaceSlug: match.workspaceSlug,
    }
  }
}

/**
 * Group server-side workspaces by the orgs we hold tokens for, preserving
 * orgs with no workspaces (so the user sees that they're a member but
 * haven't created anything there yet). Sorted alphabetically by org slug.
 */
function groupByOrg(
  tokenEntries: Array<[string, {org_slug?: string; org_name?: string}]>,
  allWorkspaces: WorkspaceEntry[],
): Array<{orgSlug: string; workosOrgId: string; workspaces: WorkspaceEntry[]}> {
  const groups: Array<{orgSlug: string; workosOrgId: string; workspaces: WorkspaceEntry[]}> = []
  for (const [orgId, tokens] of tokenEntries) {
    const slugFromToken = tokens.org_slug
    const matchingWorkspaces = allWorkspaces.filter((w) => w.workosOrgId === orgId)
    const slugFromWs = matchingWorkspaces[0]?.organizationSlug
    const orgSlug = slugFromToken ?? slugFromWs ?? slugFromName(tokens.org_name) ?? orgId
    groups.push({
      orgSlug,
      workosOrgId: orgId,
      workspaces: matchingWorkspaces.sort((a, b) => a.workspaceSlug.localeCompare(b.workspaceSlug)),
    })
  }

  return groups.sort((a, b) => a.orgSlug.localeCompare(b.orgSlug))
}

function slugFromName(name: string | undefined): string | undefined {
  if (!name) return undefined
  return name
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}
