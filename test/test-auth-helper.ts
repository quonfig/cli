import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Setup authentication files for tests
 * Creates actual token and config files in ~/.quonfig/
 * @returns Object containing paths to created token and config files
 */
export const setupTestAuth = () => {
  const quonfigDir = path.join(os.homedir(), '.quonfig')
  const tokensFile = path.join(quonfigDir, 'tokens.json')
  const configFile = path.join(quonfigDir, 'config')

  // Ensure directory exists
  fs.mkdirSync(quonfigDir, {recursive: true})

  // Write tokens file with a valid-looking JWT (header.payload.signature)
  const jwtPayload = Buffer.from(JSON.stringify({
    email: 'test@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    org_id: 'org_workspace-123',
    sub: 'user_test-123',
  })).toString('base64url')
  const mockJwt = `eyJhbGciOiJSUzI1NiJ9.${jwtPayload}.mock-signature`

  const mockTokens = {
    accessToken: mockJwt,
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    refreshToken: 'mock-refresh-token',
    userEmail: 'test@example.com',
    userId: 'user_test-123',
  }
  fs.writeFileSync(tokensFile, JSON.stringify(mockTokens, null, 2))

  // Write config file
  const configContent = `default_profile = default

[profile default]
workspace = workspace-123 # Test Organization - Test Workspace

`
  fs.writeFileSync(configFile, configContent)

  return {tokensFile, configFile}
}

/**
 * Cleanup authentication files after tests
 * @returns void
 */
export const cleanupTestAuth = () => {
  const quonfigDir = path.join(os.homedir(), '.quonfig')
  const tokensFile = path.join(quonfigDir, 'tokens.json')
  const configFile = path.join(quonfigDir, 'config')

  try {
    if (fs.existsSync(tokensFile)) fs.unlinkSync(tokensFile)
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile)
  } catch {
    // Ignore cleanup errors
  }
}
