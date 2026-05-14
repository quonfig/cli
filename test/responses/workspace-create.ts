import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock responses for `qfg workspace create` tests.
 *
 * The CLI posts to `POST /api/v1/workspaces/create` (oRPC wraps body
 * and response in `{json: ...}`). We return different payloads /
 * statuses per test by resetting handlers in-test via
 * `server.use(...)`.
 */

export const successResponse = {
  workspaceId: 'ws-uuid-new',
  workspaceSlug: 'lt-21-smoke',
  organizationSlug: 'test-organization',
  gitRepoUrl: 'https://quonfig-gitea-staging.fly.dev/test-organization/lt-21-smoke.git',
  gitRepoFullName: 'test-organization/lt-21-smoke',
  environments: [
    {id: 'env-dev', name: 'development', environmentType: 'development'},
    {id: 'env-prod', name: 'production', environmentType: 'production'},
    {id: 'env-stg', name: 'staging', environmentType: 'staging'},
  ],
}

const defaultHandler = http.post(`${getApiBase()}/api/v1/workspaces/create`, () =>
  HttpResponse.json({json: successResponse}),
)

export const server = setupServer(defaultHandler)

export const conflictHandler = http.post(`${getApiBase()}/api/v1/workspaces/create`, () =>
  HttpResponse.json(
    {
      json: {
        code: 'CONFLICT',
        message: 'Workspace "lt-21-smoke" already exists in this organization. Pick a different slug.',
      },
    },
    {status: 409},
  ),
)

export const unauthorizedHandler = http.post(`${getApiBase()}/api/v1/workspaces/create`, () =>
  HttpResponse.json({json: {code: 'UNAUTHORIZED', message: 'Unauthorized'}}, {status: 401}),
)

export const multiOrgHandler = http.post(`${getApiBase()}/api/v1/workspaces/create`, () =>
  HttpResponse.json(
    {
      json: {
        code: 'BAD_REQUEST',
        message:
          'You belong to more than one organization — specify organizationId (UUID) or organizationSlug. Use `qfg workspace` on a workspace you already own to see the slug.',
      },
    },
    {status: 400},
  ),
)
