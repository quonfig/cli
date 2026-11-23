import {expect, test} from '@oclif/test'
import {http, HttpResponse} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * `qfg workspace` in QUONFIG_API_KEY mode.
 *
 * qfg-j0j8v: the error text used to ask for `<workspace-slug>`, but every
 * other surface takes `<org>/<workspace>` (or a UUID). The command must
 * accept that form and say so.
 *
 * qfg-oscj0.8: a key is bound to one workspace, so with no
 * QUONFIG_WORKSPACE the command infers it from GET /v1/whoami.
 */

const WS_ID = '0b5f8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'

const rows = [
  {
    workspaceId: 'ws-beta-prod',
    workspaceSlug: 'production',
    workosOrgId: 'org_beta',
    organizationSlug: 'beta',
    organizationName: 'Beta',
  },
  {
    workspaceId: WS_ID,
    workspaceSlug: 'production',
    workosOrgId: 'org_acme',
    organizationSlug: 'acme',
    organizationName: 'Acme',
  },
]

const listHandler = http.post(`${getApiBase()}/api/v1/userWorkspaces/list`, () => HttpResponse.json({json: rows}))
const whoamiHandler = http.get(`${getApiBase()}/public-api/v1/whoami`, () =>
  HttpResponse.json({
    keyId: 'key-1',
    principal: {id: 'sa-1', name: 'ci-bot', type: 'service_account'},
    workspaceId: WS_ID,
  }),
)
const server = setupServer(listHandler, whoamiHandler)

describe('workspace — QUONFIG_API_KEY mode', () => {
  let originalApiKey: string | undefined
  let originalWorkspace: string | undefined

  before(() => {
    server.listen({onUnhandledRequest: 'error'})
  })

  beforeEach(() => {
    originalApiKey = process.env.QUONFIG_API_KEY
    originalWorkspace = process.env.QUONFIG_WORKSPACE
    process.env.QUONFIG_API_KEY = 'qf_sa_workspace_cmd_test'
    delete process.env.QUONFIG_WORKSPACE
  })

  afterEach(() => {
    server.resetHandlers(listHandler, whoamiHandler)
    if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
    else process.env.QUONFIG_API_KEY = originalApiKey
    if (originalWorkspace === undefined) delete process.env.QUONFIG_WORKSPACE
    else process.env.QUONFIG_WORKSPACE = originalWorkspace
  })

  after(() => {
    server.close()
  })

  test
    .stdout()
    .do(() => {
      process.env.QUONFIG_WORKSPACE = 'acme/production'
    })
    .command(['workspace'])
    .it('accepts QUONFIG_WORKSPACE=<org>/<workspace> and matches on the org (qfg-j0j8v)', (ctx) => {
      expect(ctx.stdout).to.contain('Active workspace: acme/production')
      expect(ctx.stdout).to.contain(`ID:               ${WS_ID}`)
    })

  test
    .stdout()
    .do(() => {
      process.env.QUONFIG_WORKSPACE = WS_ID
    })
    .command(['workspace'])
    .it('still accepts a UUID', (ctx) => {
      expect(ctx.stdout).to.contain('Active workspace: acme/production')
    })

  test
    .do(() => {
      process.env.QUONFIG_WORKSPACE = 'acme/missing'
    })
    .command(['workspace'])
    .catch((error) => {
      expect(error.message).to.contain('Workspace "acme/missing" not accessible with this API key')
      expect(error.message).to.contain('acme/production')
      expect(error.message).to.not.contain('<workspace-slug>')
    })
    .it('lists available workspaces as <org>/<workspace> when nothing matches (qfg-j0j8v)')

  test
    .stdout()
    .command(['workspace'])
    .it('infers the workspace from the key when QUONFIG_WORKSPACE is unset (qfg-oscj0.8)', (ctx) => {
      expect(ctx.stdout).to.contain('Active workspace: acme/production')
      expect(ctx.stdout).to.contain(`ID:               ${WS_ID}`)
      expect(ctx.stdout).to.contain('inferred from the key')
    })

  test
    .do(() => {
      server.use(
        http.get(`${getApiBase()}/public-api/v1/whoami`, () =>
          HttpResponse.json({error: 'UNAUTHORIZED', message: 'Invalid API key'}, {status: 401}),
        ),
      )
    })
    .command(['workspace'])
    .catch((error) => {
      expect(error.message).to.contain('QUONFIG_API_KEY was rejected')
      expect(error.message).to.contain('HTTP 401')
      expect(error.message).to.not.contain('<workspace-slug>')
    })
    .it('says the key was rejected when whoami returns 401 (qfg-oscj0.8)')

  test
    .do(() => {
      server.use(http.get(`${getApiBase()}/public-api/v1/whoami`, () => HttpResponse.json({}, {status: 503})))
    })
    .command(['workspace'])
    .catch((error) => {
      expect(error.message).to.contain('QUONFIG_WORKSPACE=<org>/<workspace>')
      expect(error.message).to.contain('HTTP 503')
    })
    .it('tells the user to set QUONFIG_WORKSPACE when the key workspace cannot be inferred (qfg-oscj0.8)')
})
