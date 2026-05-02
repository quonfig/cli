import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getApiUrl} from '../util/domain-urls.js'
import {getValidAccessToken} from '../util/get-valid-token.js'
import {decodeJWT} from '../util/oauth-client.js'
import {tryParseWorkspacePin} from '../util/quonfig-json.js'
import {findOrgIdBySlug, loadTokens, type TokenSet, type TokenStore} from '../util/token-storage.js'

type SessionStatus = {expired: boolean; description: string}

type OrgMembership = {
  workosOrgId: string
  slug: string
  name: string
  role: string
  sessionStatus?: SessionStatus
}

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
      sessionStatus: sessionStatusFor(t),
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
        const statusSuffix = org.sessionStatus ? ` (${org.sessionStatus.description})` : ''
        this.log(`  ${marker} ${padded}— ${org.role}${statusSuffix}`)
      }

      const expiredCount = merged.filter((o) => o.sessionStatus?.expired).length
      if (expiredCount > 0) {
        this.log('')
        this.log(`${expiredCount} of ${merged.length} session(s) expired. Run \`qfg login\` to refresh.`)
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
        sessionExpired: o.sessionStatus?.expired ?? null,
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

    // Fall back to the first token entry — gives a stable marker rather than nothing.
    const store = await loadTokens()
    if (!store) return undefined
    return Object.keys(store.tokensByOrg)[0]
  }

  /**
   * Best-effort fetch of `me.organizations` for role enrichment. Failure
   * (network, unauthenticated) is non-fatal — whoami still works from the
   * local store, just without role labels.
   */
  private async fetchOrganizations(): Promise<OrgMembership[]> {
    let jwt: string
    try {
      const store = await loadTokens()
      if (!store) return []
      const orgId = pickAnyOrgId(store)
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
  for (const o of server) {
    // Server data wins for slug/name/role but lacks sessionStatus — that's
    // a property of the locally-cached token, so preserve it.
    const existing = merged.get(o.workosOrgId)
    merged.set(o.workosOrgId, {...o, sessionStatus: existing?.sessionStatus})
  }

  return [...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Read-only check of a TokenSet's expiry. Prefers the JWT's `exp` claim
 * (matches getValidAccessToken's logic), falls back to the stored
 * `expires_at` timestamp if the JWT can't be decoded. No network calls —
 * whoami stays fast even with many cached orgs.
 */
function sessionStatusFor(tokens: TokenSet): SessionStatus {
  let expMs = tokens.expires_at
  try {
    const payload = decodeJWT(tokens.access_token)
    if (typeof payload.exp === 'number') expMs = payload.exp * 1000
  } catch {
    /* keep stored expires_at */
  }

  const delta = expMs - Date.now()
  if (delta <= 0) return {expired: true, description: 'expired — run `qfg login`'}
  return {expired: false, description: `expires in ${formatRelative(delta)}`}
}

function formatRelative(deltaMs: number): string {
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
}

function pickAnyOrgId(store: TokenStore): string | undefined {
  if (store.defaultOrgId && store.tokensByOrg[store.defaultOrgId]) return store.defaultOrgId
  return Object.keys(store.tokensByOrg)[0]
}
