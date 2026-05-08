import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Setup authentication files for tests.
 *
 * Creates a temporary directory, points `QUONFIG_CONFIG_HOME` at it, and
 * writes a fake JWT + profile config inside. The CLI's storage helpers
 * (token-storage, gitea-token-storage) read `QUONFIG_CONFIG_HOME` so they'll
 * see these fixtures instead of the user's real `~/.quonfig/`.
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

  const tokensFile = path.join(quonfigDir, 'tokens.json')
  const configFile = path.join(quonfigDir, 'config')

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
