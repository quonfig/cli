import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'

import {getIdApiUrl} from './domain-urls.js'

const CLIENT_ID = 'quonfig-cli-public'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'

// Try these ports in order until we find one that's available
const FALLBACK_PORTS = [8765, 8766, 8767, 8768, 8769, 8770]

export interface OAuthTokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
}

export interface WorkspaceInfo {
  authz_jwt: string
  id: string
  name: string
}

export interface OrganizationInfo {
  id: string
  name: string
  roles: string[]
  workspaces: WorkspaceInfo[]
}

export interface IntrospectionResponse {
  authn_jwt: string
  organizations: OrganizationInfo[]
}

const getRedirectUri = (port: number): string => `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`

// Generate PKCE code verifier and challenge
const generateCodeVerifier = (): string => crypto.randomBytes(32).toString('base64url')

const generateCodeChallenge = (verifier: string): string =>
  crypto.createHash('sha256').update(verifier).digest('base64url')

export const generateAuthUrl = (port: number, codeVerifier: string, domain?: string): string => {
  const idUrl = getIdApiUrl(domain)
  const codeChallenge = generateCodeChallenge(codeVerifier)

  /* eslint-disable camelcase */
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: getRedirectUri(port),
    response_type: 'code',
    scope: 'public read write',
  })
  /* eslint-enable camelcase */

  return `${idUrl}/oauth/authorize?${params.toString()}`
}

export const createCodeVerifier = (): string => generateCodeVerifier()

const tryStartServer = (port: number): Promise<{port: number; server: http.Server} | null> =>
  new Promise((resolve) => {
    const server = http.createServer()

    const onError = () => {
      server.close()
      resolve(null)
    }

    const onListening = () => {
      server.removeListener('error', onError)
      resolve({port, server})
    }

    server.once('error', onError)
    server.once('listening', onListening)

    server.listen(port, CALLBACK_HOST)
  })

const findAvailablePort = async (): Promise<{port: number; server: http.Server}> => {
  for (const port of FALLBACK_PORTS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await tryStartServer(port)
    if (result) {
      return result
    }
  }

  throw new Error(
    `Could not find an available port. Tried ports: ${FALLBACK_PORTS.join(', ')}. Please close any applications using these ports and try again.`,
  )
}

export const startCallbackServer = async (): Promise<{
  port: number
  waitForCallback: () => Promise<string>
  close: () => void
}> => {
  // First, find an available port
  const {port, server} = await findAvailablePort()

  console.log(`Listening for OAuth callback on port ${port}...`)

  const waitForCallback = (): Promise<string> =>
    new Promise((resolve, reject) => {
      // Set up request handler now that we have a port
      server.on('request', (req, res) => {
        if (req.url?.startsWith(CALLBACK_PATH)) {
          const url = new URL(req.url, `http://${req.headers.host}`)
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')

          if (error) {
            res.writeHead(400, {'Content-Type': 'text/html'})
            res.end('<html><body><h1>Authentication failed</h1><p>You can close this window.</p></body></html>')
            reject(new Error(`OAuth error: ${error}`))
            return
          }

          if (code) {
            res.writeHead(200, {'Content-Type': 'text/html'})
            res.end(
              '<html><body><h1>Authentication successful!</h1><p>You can close this window and return to the CLI.</p></body></html>',
            )
            resolve(code)
            return
          }

          res.writeHead(400, {'Content-Type': 'text/html'})
          res.end('<html><body><h1>Invalid request</h1><p>You can close this window.</p></body></html>')
          reject(new Error('No code or error in callback'))
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      })
    })

  return {
    close: () => server.close(),
    port,
    waitForCallback,
  }
}

export const exchangeCodeForTokens = async (
  code: string,
  port: number,
  codeVerifier: string,
  domain?: string,
): Promise<OAuthTokenResponse> => {
  const idUrl = getIdApiUrl(domain)

  /* eslint-disable camelcase */
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(port),
  })
  /* eslint-enable camelcase */

  // Create an agent that ignores SSL errors for local development
  const agent = process.env.IDENTITY_BASE_URL_OVERRIDE ? new https.Agent({rejectUnauthorized: false}) : undefined

  const response = await fetch(`${idUrl}/oauth/token`, {
    // @ts-expect-error - agent is valid for https URLs
    agent,
    body: params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to exchange code for tokens: ${errorText}`)
  }

  return response.json()
}

export const refreshAccessToken = async (refreshToken: string, domain?: string): Promise<OAuthTokenResponse> => {
  const idUrl = getIdApiUrl(domain)

  /* eslint-disable camelcase */
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  /* eslint-enable camelcase */

  // Create an agent that ignores SSL errors for local development
  const agent = process.env.IDENTITY_BASE_URL_OVERRIDE ? new https.Agent({rejectUnauthorized: false}) : undefined

  const response = await fetch(`${idUrl}/oauth/token`, {
    // @ts-expect-error - agent is valid for https URLs
    agent,
    body: params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to refresh token: ${errorText}`)
  }

  return response.json()
}

export const introspectToken = async (
  accessToken: string,
  domain?: string,
  verbose?: boolean,
): Promise<IntrospectionResponse> => {
  const identityUrl = getIdApiUrl(domain)
  const introspectUrl = `${identityUrl}/api/oauth/identity`

  // Log verbose info if verbose flag is set
  if (verbose) {
    console.error(`[introspectToken] Identity URL: ${identityUrl}`)
    console.error(`[introspectToken] Full introspection URL: ${introspectUrl}`)
    console.error(`[introspectToken] Token (first 50 chars): ${accessToken.slice(0, 50)}...`)
  }

  // Create an agent that ignores SSL errors for local development
  const agent = process.env.IDENTITY_BASE_URL_OVERRIDE ? new https.Agent({rejectUnauthorized: false}) : undefined

  const response = await fetch(introspectUrl, {
    // @ts-expect-error - agent is valid for https URLs
    agent,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    method: 'GET',
  })

  if (!response.ok) {
    const errorText = await response.text()
    if (verbose) {
      console.error(`[introspectToken] Response status: ${response.status}`)
      console.error(`[introspectToken] Response error: ${errorText}`)
    }
    throw new Error(`Failed to get identity: ${errorText}`)
  }

  const data = await response.json()

  return data
}

export const decodeJWT = (token: string): Record<string, unknown> => {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }
  return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
}
