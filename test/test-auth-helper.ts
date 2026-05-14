import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {getAuthConfigFilePath, getTokenFilePath} from '../src/util/token-storage.js'

/**
 * Setup authentication files for tests.
 *
 * Creates a temporary directory, points `QUONFIG_CONFIG_HOME` at it, and
 * writes a fake JWT + profile config inside. The CLI's storage helpers
 * (token-storage, gitea-token-storage) read `QUONFIG_CONFIG_HOME` so they'll
 * see these fixtures instead of the user's real `~/.quonfig/`.
 *
 * The token/config filenames are domain-suffixed when `QUONFIG_DOMAIN` is set
 * (e.g. CI sets `quonfig-staging.com`, so the CLI reads
 * `tokens-quonfig-staging-com.json`). We resolve the fixture paths through the
 * same `getTokenFilePath` / `getAuthConfigFilePath` helpers the CLI uses, so
 * the fixtures land where the CLI actually looks regardless of `QUONFIG_DOMAIN`.
 *
 * Pair every call with `cleanupTestAuth()`.
 */
let activeTmpDir: string | undefined
let prevConfigHome: string | undefined
let prevConfigHomeWasSet = false
let prevSaved = false

const savePrevEnv = () => {
  if (prevSaved) return
  prevConfigHomeWasSet = Object.hasOwn(process.env, 'QUONFIG_CONFIG_HOME')
  prevConfigHome = process.env.QUONFIG_CONFIG_HOME
  prevSaved = true
}

const removeActiveTmpDir = () => {
  if (!activeTmpDir) return
  try {
    fs.rmSync(activeTmpDir, {force: true, recursive: true})
  } catch {
    // Ignore cleanup errors
  }

  activeTmpDir = undefined
}

export const setupTestAuth = () => {
  savePrevEnv()
  removeActiveTmpDir()

  const quonfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-test-'))
  process.env.QUONFIG_CONFIG_HOME = quonfigDir
  activeTmpDir = quonfigDir

  // Resolve via the CLI's own helpers — QUONFIG_CONFIG_HOME is set above, and
  // these honor QUONFIG_DOMAIN so the fixture filenames match what the CLI reads.
  const tokensFile = getTokenFilePath()
  const configFile = getAuthConfigFilePath()

  const jwtPayload = Buffer.from(
    JSON.stringify({
      email: 'test@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      org_id: 'org_workspace-123',
      sub: 'user_test-123',
    }),
  ).toString('base64url')
  const mockJwt = `eyJhbGciOiJSUzI1NiJ9.${jwtPayload}.mock-signature`

  const mockTokens = {
    defaultOrgId: 'org_workspace-123',
    tokensByOrg: {
      'org_workspace-123': {
        access_token: mockJwt,
        expires_at: Date.now() + 3_600_000,
        refresh_token: 'mock-refresh-token',
        user_email: 'test@example.com',
        user_id: 'user_test-123',
        org_slug: 'test-organization',
        org_name: 'Test Organization',
      },
    },
  }
  fs.writeFileSync(tokensFile, JSON.stringify(mockTokens, null, 2))

  const configContent = `default_profile = default

[profile default]
workspace = workspace-123 # Test Organization - Test Workspace
organization_slug = test-organization

`
  fs.writeFileSync(configFile, configContent)

  return {configFile, tokensFile}
}

/**
 * Resolve the on-disk tokens-file path the CLI will read, honoring
 * `QUONFIG_DOMAIN` (CI sets it, so the real filename is
 * `tokens-<domain>.json`, not `tokens.json`). Use this instead of
 * `path.join(QUONFIG_CONFIG_HOME, 'tokens.json')` when a test needs to
 * rewrite the tokens fixture after `setupTestAuth()`.
 */
export const testTokensPath = (): string => {
  if (!process.env.QUONFIG_CONFIG_HOME) {
    throw new Error('QUONFIG_CONFIG_HOME unset — setupTestAuth must run before this test')
  }
  return getTokenFilePath()
}

/**
 * Resolve the on-disk auth-config path the CLI will read, honoring
 * `QUONFIG_DOMAIN` (the real filename is `config-<domain>` when set).
 * Companion to {@link testTokensPath}.
 */
export const testConfigPath = (): string => {
  if (!process.env.QUONFIG_CONFIG_HOME) {
    throw new Error('QUONFIG_CONFIG_HOME unset — setupTestAuth must run before this test')
  }
  return getAuthConfigFilePath()
}

/**
 * Force the CLI's auth lookup to see no tokens, regardless of the developer's
 * real `~/.quonfig/` or any pre-existing `QUONFIG_CONFIG_HOME`. Use this in
 * "not logged in" describe blocks instead of `cleanupTestAuth()` — cleanup
 * restores the *original* env value, which on a dev machine is undefined and
 * resolves to `~/.quonfig/` where real tokens live, leaking them into the
 * test process. CI passes because runners have no `~/.quonfig/`.
 *
 * The pointed-at directory is fresh and empty (no tokens file), so
 * `loadTokens()` returns null reliably.
 */
export const disableAuth = (): void => {
  savePrevEnv()
  removeActiveTmpDir()

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-test-noauth-'))
  process.env.QUONFIG_CONFIG_HOME = emptyDir
  activeTmpDir = emptyDir
}

export const cleanupTestAuth = () => {
  removeActiveTmpDir()

  if (prevSaved) {
    if (prevConfigHomeWasSet) {
      process.env.QUONFIG_CONFIG_HOME = prevConfigHome
    } else {
      delete process.env.QUONFIG_CONFIG_HOME
    }

    prevConfigHome = undefined
    prevConfigHomeWasSet = false
    prevSaved = false
  }
}
