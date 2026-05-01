import {authenticateWithOrg} from './oauth-client.js'
import type {TokenSet, TokenStore} from './token-storage.js'

export interface OrgMembership {
  name: string
  role: string
  slug: string
  workosOrgId: string
}

export interface OrchestrateLoginInput {
  apiUrl: string
  initialAccessToken: string
  initialRefreshToken: string
  user: {email?: string; id: string}
}

export interface OrchestrateLoginResult {
  defaultOrg: OrgMembership
  defaultOrgId: string
  email?: string
  mintedOrgSlugs: string[]
  organizations: OrgMembership[]
  skippedOrgSlugs: string[]
  tokenStore: TokenStore
  userId: string
}

const MAX_EAGER_ORGS = 10

/**
 * Fetch all org memberships for the authenticated user from app-quonfig.
 * Uses the initial user-scoped access token (no org_id) so the call works
 * before any per-org tokens have been minted.
 */
const fetchOrganizations = async (apiUrl: string, accessToken: string): Promise<OrgMembership[]> => {
  const res = await fetch(`${apiUrl}/api/v1/me/organizations`, {
    body: JSON.stringify({json: {}}),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch organizations: ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as {json?: OrgMembership[]}
  const list = (body.json ?? body) as unknown as OrgMembership[]
  if (!Array.isArray(list)) {
    throw new TypeError('Failed to fetch organizations: response was not a list')
  }

  return list
}

/**
 * Multi-org token minting orchestration (qfg-mol-k27, plan item 7).
 *
 * Given the device-auth result, this:
 *   1. Calls /api/v1/me/organizations to enumerate all orgs the user belongs to.
 *   2. For each org (capped at 10 alphabetically — see plan rate-limit guard),
 *      calls WorkOS /user_management/authenticate with grant_type=refresh_token
 *      + organization_id in parallel to mint an org-scoped TokenSet.
 *   3. Builds the per-org TokenStore with a defaultOrgId set to the only org
 *      (single-org user) or the first slug alphabetically (multi-org).
 *
 * Returns the in-memory TokenStore plus enough metadata for login.ts to print
 * the user-facing summary; persistence is the caller's responsibility so we
 * keep this helper free of filesystem side effects (testable in isolation).
 */
export const orchestrateMultiOrgLogin = async (input: OrchestrateLoginInput): Promise<OrchestrateLoginResult> => {
  const allOrgs = await fetchOrganizations(input.apiUrl, input.initialAccessToken)
  if (allOrgs.length === 0) {
    throw new Error(
      'Login failed: this user is not a member of any organization. Have an admin invite you, then re-run `qfg login`.',
    )
  }

  const sorted = [...allOrgs].sort((a, b) => a.slug.localeCompare(b.slug))
  const minted = sorted.slice(0, MAX_EAGER_ORGS)
  const skipped = sorted.slice(MAX_EAGER_ORGS)

  const tokenSets = await Promise.all(
    minted.map(async (org): Promise<[string, TokenSet]> => {
      const set = await authenticateWithOrg(input.initialRefreshToken, org.workosOrgId)
      return [
        org.workosOrgId,
        {
          ...set,
          org_name: org.name,
          org_slug: org.slug,
        },
      ]
    }),
  )

  const tokensByOrg: TokenStore['tokensByOrg'] = {}
  for (const [orgId, set] of tokenSets) {
    tokensByOrg[orgId] = set
  }

  const defaultOrg = minted[0]

  return {
    defaultOrg,
    defaultOrgId: defaultOrg.workosOrgId,
    email: input.user.email,
    mintedOrgSlugs: minted.map((o) => o.slug),
    organizations: sorted,
    skippedOrgSlugs: skipped.map((o) => o.slug),
    tokenStore: {
      defaultOrgId: defaultOrg.workosOrgId,
      tokensByOrg,
    },
    userId: input.user.id,
  }
}
