import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

/**
 * MSW handlers for `qfg delete` tests.
 *
 * Routes mocked (oRPC, body & response wrapped in {json: ...}):
 *   POST /api/v1/metadata/list      → resolves a key to its type (flag/config/log_level)
 *   POST /api/v1/flags/delete       → delete a feature flag
 *   POST /api/v1/configs/delete     → delete a config
 *   POST /api/v1/logLevels/delete   → delete a log-level config
 */

// Captured request payloads, asserted against in tests.
export let lastFlagDeleteInput: any = null
export let lastConfigDeleteInput: any = null
export let lastLogLevelDeleteInput: any = null
export let flagDeleteCallCount = 0
export let configDeleteCallCount = 0
export let logLevelDeleteCallCount = 0

export function resetCaptured() {
  lastFlagDeleteInput = null
  lastConfigDeleteInput = null
  lastLogLevelDeleteInput = null
  flagDeleteCallCount = 0
  configDeleteCallCount = 0
  logLevelDeleteCallCount = 0
}

const metadataResponse = {
  configs: [
    {
      key: 'feature.flag.to-delete',
      type: 'feature_flag',
      valueType: 'bool',
      version: 'sha-flag-current',
    },
    {
      key: 'config.to-delete',
      type: 'config',
      valueType: 'string',
      version: 'sha-config-current',
    },
    {
      key: 'log-level.to-delete',
      type: 'log_level',
      valueType: 'log_level',
      version: 'sha-log-current',
    },
  ],
}

const metadataListHandler = http.post('https://app.quonfig.com/api/v1/metadata/list', () =>
  HttpResponse.json({json: metadataResponse}),
)

const flagsDeleteHandler = http.post('https://app.quonfig.com/api/v1/flags/delete', async ({request}) => {
  const body = (await request.json()) as any
  lastFlagDeleteInput = body?.json
  flagDeleteCallCount += 1
  return HttpResponse.json({json: {ok: true, commitSha: 'sha-after-delete'}})
})

const configsDeleteHandler = http.post('https://app.quonfig.com/api/v1/configs/delete', async ({request}) => {
  const body = (await request.json()) as any
  lastConfigDeleteInput = body?.json
  configDeleteCallCount += 1
  return HttpResponse.json({json: {ok: true, commitSha: 'sha-after-delete'}})
})

const logLevelsDeleteHandler = http.post(
  'https://app.quonfig.com/api/v1/logLevels/delete',
  async ({request}) => {
    const body = (await request.json()) as any
    lastLogLevelDeleteInput = body?.json
    logLevelDeleteCallCount += 1
    return HttpResponse.json({json: {ok: true, commitSha: 'sha-after-delete'}})
  },
)

export const server = setupServer(
  metadataListHandler,
  flagsDeleteHandler,
  configsDeleteHandler,
  logLevelsDeleteHandler,
)
