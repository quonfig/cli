import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getApiUrl} from '../util/domain-urls.js'
import {getValidAccessToken, resolveDefaultOrgId} from '../util/get-valid-token.js'
import {decodeJWT} from '../util/oauth-client.js'
import {tryParseWorkspacePin} from '../util/quonfig-json.js'
import {findOrgIdBySlug, loadTokens} from '../util/token-storage.js'

type OrgMembership = {workosOrgId: string; slug: string; name: string; role: string}

export default class Whoami extends BaseCommand {
  static description = 'Display information about the currently logged in user and all org memberships'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    const store = await loadTokens()
    if (!store || Object.keys(store.tokensByOrg).length === 0) {
      this.log('Not logged in. Use `qfg login` to authenticate.')
      return {loggedIn: false}
    }

    const firstEntry = Object.values(store.tokensByOrg)[0]
    let userEmail = firstEntry.user_email
    if (!userEmail && firstEntry.access_token) {
      try {
        const payload = decodeJWT(firstEntry.access_token)
        userEmail = payload.email as string
      } catch {
        // Continue without email if JWT decode fails.
      }
    }

    const activeOrgId = await this.resolveActiveOrgId(store.defaultOrgId)
    const memberships = await this.fetchOrganizations()

    const localOrgs: OrgMembership[] = Object.entries(store.tokensByOrg).map(([orgId, t]) => ({
      workosOrgId: orgId,
      slug: t.org_slug ?? orgId,
      name: t.org_name ?? t.org_slug ?? orgId,
      role: '—',
    }))
    const merged = mergeMemberships(localOrgs, memberships)

    this.log(`Logged in as: ${userEmail || 'Unknown'}`)
    this.log('Orgs:')
    if (merged.length === 0) {
      this.log('  (no orgs cached — run `qfg login` to mint per-org tokens)')
    } else {
      const labelWidth = Math.max(...merged.map((o) => o.slug.length + (o.workosOrgId === activeOrgId ? 9 : 0))) + 1
      for (const org of merged) {
        const marker = org.workosOrgId === activeOrgId ? '*' : ' '
        const label = `${org.slug}${org.workosOrgId === activeOrgId ? ' (active)' : ''}`
        const padded = label.padEnd(labelWidth, ' ')
        this.log(`  ${marker} ${padded}— ${org.role}`)
      }
    }

    return {
      loggedIn: true,
      email: userEmail,
      userId: firstEntry.user_id,
      activeOrgId,
      orgs: merged.map((o) => ({
        workosOrgId: o.workosOrgId,
        slug: o.slug,
        name: o.name,
        role: o.role,
        active: o.workosOrgId === activeOrgId,
      })),
    }
  }

  /**
   * Pick the "active" org for display. Order:
   *   1. QUONFIG_WORKSPACE in `org/ws` form → look up org by slug in the store.
   *   2. The token store's defaultOrgId, if it points at an entry we have.
   *   3. The first token entry — gives a stable marker rather than nothing.
   */
  private async resolveActiveOrgId(defaultOrgId: string | undefined): Promise<string | undefined> {
    const env = process.env.QUONFIG_WORKSPACE
    if (env) {
      const pin = tryParseWorkspacePin(env)
      if (pin) {
        const store = await loadTokens()
        if (store) {
          const matched = findOrgIdBySlug(store, pin.orgSlug)
          if (matched) return matched
        }
      }
    }

    if (defaultOrgId) return defaultOrgId
    return resolveDefaultOrgId().then((id) => id || undefined)
  }

  /**
   * Best-effort fetch of `me.organizations` for role enrichment. Failure
   * (network, unauthenticated) is non-fatal — whoami still works from the
   * local store, just without role labels.
   */
  private async fetchOrganizations(): Promise<OrgMembership[]> {
    let jwt: string
    try {
      const orgId = await resolveDefaultOrgId()
      if (!orgId) return []
      jwt = await getValidAccessToken(orgId, this.verboseLog)
    } catch (error) {
      this.verboseLog('whoami: failed to mint JWT for me.organizations', {error: String(error)})
      return []
    }

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/me/organizations`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({json: {}}),
      })
      if (!res.ok) {
        this.verboseLog('whoami: me.organizations returned non-OK', {status: res.status})
        return []
      }

      const body = (await res.json()) as {json?: OrgMembership[]}
      const list = (body.json ?? body) as unknown as OrgMembership[]
      return Array.isArray(list) ? list : []
    } catch (error) {
      this.verboseLog('whoami: me.organizations fetch failed', {error: String(error)})
      return []
    }
  }
}

/**
 * Combine the locally-cached orgs (one entry per token) with the server's
 * me.organizations response. Server data wins for slug/name/role; entries
 * present locally but missing from the server are kept (a token cached for
 * an org the user has since been removed from). Server-only entries are
 * also included so the user sees all current memberships.
 */
function mergeMemberships(local: OrgMembership[], server: OrgMembership[]): OrgMembership[] {
  const merged = new Map<string, OrgMembership>()
  for (const o of local) merged.set(o.workosOrgId, o)
  for (const o of server) merged.set(o.workosOrgId, o)
  return [...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}
