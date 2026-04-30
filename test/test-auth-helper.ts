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

export const setupTestAuth = () => {
  const quonfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-test-'))

  prevConfigHomeWasSet = Object.prototype.hasOwnProperty.call(process.env, 'QUONFIG_CONFIG_HOME')
  prevConfigHome = process.env.QUONFIG_CONFIG_HOME
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
      },
    },
  }
  fs.writeFileSync(tokensFile, JSON.stringify(mockTokens, null, 2))

  const configContent = `default_profile = default

[profile default]
workspace = workspace-123 # Test Organization - Test Workspace

`
  fs.writeFileSync(configFile, configContent)

  return {configFile, tokensFile}
}

export const cleanupTestAuth = () => {
  if (activeTmpDir) {
    try {
      fs.rmSync(activeTmpDir, {force: true, recursive: true})
    } catch {
      // Ignore cleanup errors
    }

    activeTmpDir = undefined
  }

  if (prevConfigHomeWasSet) {
    process.env.QUONFIG_CONFIG_HOME = prevConfigHome
  } else {
    delete process.env.QUONFIG_CONFIG_HOME
  }

  prevConfigHome = undefined
  prevConfigHomeWasSet = false
}
