import {expect} from '@oclif/test'
import {afterEach, beforeEach, describe, it} from 'mocha'

import getClient, {resetClientCache} from '../../src/util/get-client.js'
import {resolveWorkspaceUuid} from '../../src/util/resolve-workspace.js'

/**
 * qfg-oscj0.8: an API key (qf_uk_ or qf_sa_) is bound to exactly one
 * workspace server-side, so QUONFIG_WORKSPACE is optional when
 * QUONFIG_API_KEY is set. With neither --workspace nor QUONFIG_WORKSPACE,
 * the CLI asks GET /v1/whoami (mounted at /public-api/v1/whoami on the app
 * host) for the key's workspaceId, then labels it from userWorkspaces.list.
 * An explicit value still wins and never calls whoami.
 */

const WS_ID = '0b5f8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'

type FetchCall = {method: string; url: string; auth?: string}

const listRows = [
  // A user key's list holds every workspace the user can reach; the key's
  // own workspace must be picked by id, not by position.
  {
    workspaceId: 'ws-other',
    workspaceSlug: 'staging',
    organizationSlug: 'acme',
    organizationName: 'Acme',
    workosOrgId: 'org_acme',
  },
  {
    workspaceId: WS_ID,
    workspaceSlug: 'production',
    organizationSlug: 'acme',
    organizationName: 'Acme',
    workosOrgId: 'org_acme',
  },
]

describe('API-key workspace inference (qfg-oscj0.8)', () => {
  let originalApiKey: string | undefined
  let originalWorkspace: string | undefined
  let originalDomain: string | undefined
  let originalApiOverride: string | undefined
  let originalFetch: typeof globalThis.fetch
  let calls: FetchCall[]

  beforeEach(() => {
    originalApiKey = process.env.QUONFIG_API_KEY
    originalWorkspace = process.env.QUONFIG_WORKSPACE
    originalDomain = process.env.QUONFIG_DOMAIN
    originalApiOverride = process.env.QUONFIG_API_BASE_URL_OVERRIDE
    process.env.QUONFIG_API_BASE_URL_OVERRIDE = 'https://app.test.invalid'
    delete process.env.QUONFIG_WORKSPACE
    originalFetch = globalThis.fetch
    calls = []
    resetClientCache()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetClientCache()
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }

    restore('QUONFIG_API_KEY', originalApiKey)
    restore('QUONFIG_WORKSPACE', originalWorkspace)
    restore('QUONFIG_DOMAIN', originalDomain)
    restore('QUONFIG_API_BASE_URL_OVERRIDE', originalApiOverride)
  })

  const stubFetch = (opts: {whoamiStatus?: number; whoamiBody?: unknown; listStatus?: number; rows?: unknown[]}) => {
    globalThis.fetch = (async (url: unknown, init?: {method?: string; headers?: Record<string, string>}) => {
      const u = typeof url === 'string' ? url : (url as URL).toString()
      calls.push({auth: init?.headers?.Authorization, method: init?.method ?? 'GET', url: u})
      if (u.endsWith('/public-api/v1/whoami')) {
        const status = opts.whoamiStatus ?? 200
        const body = opts.whoamiBody ?? {
          keyId: 'key-1',
          principal: {id: 'sa-1', name: 'ci-bot', type: 'service_account'},
          workspaceId: WS_ID,
        }
        return new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}, status})
      }

      if (u.endsWith('/api/v1/userWorkspaces/list')) {
        return new Response(JSON.stringify({json: opts.rows ?? listRows}), {
          headers: {'Content-Type': 'application/json'},
          status: opts.listStatus ?? 200,
        })
      }

      throw new Error(`unexpected fetch in test: ${u}`)
    }) as typeof globalThis.fetch
  }

  const makeFakeCommand = () => {
    const cmd = {
      errors: [] as string[],
      verboseLog() {},
      workspaceId: undefined as string | undefined,
      workspaceLabel: undefined as string | undefined,
      error(msg: string | Error) {
        const text = typeof msg === 'string' ? msg : msg.message
        cmd.errors.push(text)
        throw new Error(text)
      },
    }
    return cmd
  }

  const asResolveCmd = (cmd: ReturnType<typeof makeFakeCommand>) =>
    cmd as unknown as Parameters<typeof resolveWorkspaceUuid>[0]
  const asClientCmd = (cmd: ReturnType<typeof makeFakeCommand>) => cmd as unknown as Parameters<typeof getClient>[0]

  describe('resolveWorkspaceUuid', () => {
    it('infers the workspace of a qf_sa_ key from whoami and labels it from the one-row list', async () => {
      process.env.QUONFIG_API_KEY = 'qf_sa_inference_test'
      stubFetch({rows: [listRows[1]]})

      const result = await resolveWorkspaceUuid(asResolveCmd(makeFakeCommand()))

      expect(result).to.deep.equal({orgSlug: 'acme', workspaceId: WS_ID})
      const whoami = calls.find((c) => c.url.endsWith('/public-api/v1/whoami'))
      expect(whoami, 'must ask whoami for the key workspace').to.exist
      expect(whoami!.method).to.equal('GET')
      expect(whoami!.auth).to.equal('Bearer qf_sa_inference_test')
    })

    it('infers the workspace of a qf_uk_ key by id even when the list holds other workspaces', async () => {
      process.env.QUONFIG_API_KEY = 'qf_uk_inference_test'
      stubFetch({})

      const result = await resolveWorkspaceUuid(asResolveCmd(makeFakeCommand()))

      expect(result).to.deep.equal({orgSlug: 'acme', workspaceId: WS_ID})
    })

    it('still returns the inferred id (with no org slug) when the list call fails', async () => {
      process.env.QUONFIG_API_KEY = 'qf_sa_inference_test'
      stubFetch({listStatus: 500})

      const result = await resolveWorkspaceUuid(asResolveCmd(makeFakeCommand()))

      expect(result).to.deep.equal({orgSlug: '', workspaceId: WS_ID})
    })

    it('errors telling the user to set QUONFIG_WORKSPACE when whoami fails', async () => {
      process.env.QUONFIG_API_KEY = 'qf_sa_inference_test'
      stubFetch({whoamiBody: {error: 'UNAUTHORIZED', message: 'Invalid API key'}, whoamiStatus: 401})

      const cmd = makeFakeCommand()
      let caught: Error | undefined
      try {
        await resolveWorkspaceUuid(asResolveCmd(cmd))
      } catch (error) {
        caught = error as Error
      }

      expect(caught, 'expected an error').to.exist
      expect(caught!.message).to.include('QUONFIG_WORKSPACE=<org>/<workspace>')
      expect(caught!.message).to.include('HTTP 401')
    })

    it('does not call whoami when QUONFIG_WORKSPACE is a UUID (explicit value wins, unchanged)', async () => {
      process.env.QUONFIG_API_KEY = 'qf_sa_inference_test'
      process.env.QUONFIG_WORKSPACE = '11111111-2222-4333-8444-555555555555'
      stubFetch({})

      const result = await resolveWorkspaceUuid(asResolveCmd(makeFakeCommand()))

      expect(result).to.deep.equal({orgSlug: '', workspaceId: '11111111-2222-4333-8444-555555555555'})
      expect(calls).to.have.length(0)
    })

    it('does not call whoami when --workspace is given as org/workspace', async () => {
      process.env.QUONFIG_API_KEY = 'qf_uk_inference_test'
      stubFetch({})

      const result = await resolveWorkspaceUuid(asResolveCmd(makeFakeCommand()), 'acme/staging')

      expect(result).to.deep.equal({orgSlug: 'acme', workspaceId: 'ws-other'})
      expect(calls.some((c) => c.url.endsWith('/whoami'))).to.equal(false)
    })
  })

  describe('getClient', () => {
    it('infers the workspace id and an org/workspace label when no workspace is given', async () => {
      process.env.QUONFIG_API_KEY = 'qf_uk_inference_test'
      stubFetch({})

      const cmd = makeFakeCommand()
      await getClient(asClientCmd(cmd))

      expect(cmd.workspaceId).to.equal(WS_ID)
      expect(cmd.workspaceLabel).to.equal('acme/production')
    })

    it('errors telling the user to set QUONFIG_WORKSPACE when whoami is unreachable', async () => {
      process.env.QUONFIG_API_KEY = 'qf_sa_inference_test'
      globalThis.fetch = (async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }) as typeof globalThis.fetch

      const cmd = makeFakeCommand()
      let caught: Error | undefined
      try {
        await getClient(asClientCmd(cmd))
      } catch (error) {
        caught = error as Error
      }

      expect(caught, 'expected an error').to.exist
      expect(caught!.message).to.include('QUONFIG_WORKSPACE=<org>/<workspace>')
      expect(caught!.message).to.include('ENOTFOUND')
    })

    it('uses an explicit UUID profile without calling whoami (unchanged)', async () => {
      process.env.QUONFIG_API_KEY = 'qf_sa_inference_test'
      stubFetch({})

      const cmd = makeFakeCommand()
      await getClient(asClientCmd(cmd), undefined, '11111111-2222-4333-8444-555555555555')

      expect(cmd.workspaceId).to.equal('11111111-2222-4333-8444-555555555555')
      expect(calls).to.have.length(0)
    })
  })
})
