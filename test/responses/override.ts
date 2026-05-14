import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * MSW handlers for qfg override tests.
 *
 * Routes mocked (oRPC, body & response wrapped in {json: ...}):
 *   POST /api/v1/flags/list                  → list flags (for --list, --clear)
 *   POST /api/v1/flags/getByKey              → fetch single flag (for currentSha + idempotency check)
 *   POST /api/v1/flags/findOrCreateOverride  → set override
 *   POST /api/v1/flags/removeOverride        → remove override
 */

export const TEST_USER_EMAIL = 'test@example.com'

// Captured request payloads, asserted against in tests.
export let lastFindOrCreateInput: any = null
export let lastRemoveInput: any = null
export let findOrCreateCallCount = 0
export let removeCallCount = 0

export function resetCaptured() {
  lastFindOrCreateInput = null
  lastRemoveInput = null
  findOrCreateCallCount = 0
  removeCallCount = 0
}

// Stubbed flag library — keyed by flag key. Each entry models the JSON file
// the server would have read from Gitea.
function buildFlag(opts: {
  key: string
  valueType: string
  rules?: Array<{criteria: any[]; value: any}>
  envRules?: Record<string, Array<{criteria: any[]; value: any}>>
  commitSha?: string
}) {
  const environments = Object.entries(opts.envRules ?? {}).map(([id, rules]) => ({id, rules}))
  return {
    key: opts.key,
    type: 'feature_flag',
    valueType: opts.valueType,
    sendToClientSdk: true,
    tags: [],
    default: {
      rules: opts.rules ?? [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: opts.valueType, value: false}}],
    },
    environments,
    variants: [],
    environmentCount: environments.length,
    commitSha: opts.commitSha ?? 'sha-current',
  }
}

const overrideRule = (emails: string[], value: any) => ({
  criteria: [
    {
      propertyName: 'quonfig-user.email',
      operator: 'PROP_IS_ONE_OF',
      valueToMatch: {type: 'string_list', value: emails},
    },
  ],
  value,
})

// Default flag library used by most tests. Tests can override per-handler with
// server.use(...).
const FLAGS: Record<string, any> = {
  'feature.simple': buildFlag({key: 'feature.simple', valueType: 'bool'}),
  'feature.with-mine': buildFlag({
    key: 'feature.with-mine',
    valueType: 'bool',
    envRules: {
      Development: [overrideRule([TEST_USER_EMAIL], {type: 'bool', value: true})],
    },
  }),
  'feature.someone-else': buildFlag({
    key: 'feature.someone-else',
    valueType: 'bool',
    envRules: {
      Development: [overrideRule(['other@example.com'], {type: 'bool', value: true})],
    },
  }),
  'feature.stale-once': buildFlag({key: 'feature.stale-once', valueType: 'bool', commitSha: 'sha-stale'}),
  'feature.idempotent': buildFlag({
    key: 'feature.idempotent',
    valueType: 'bool',
    envRules: {
      Development: [overrideRule([TEST_USER_EMAIL], {type: 'bool', value: true})],
    },
  }),
  'feature.no-override': buildFlag({key: 'feature.no-override', valueType: 'bool'}),
}

// Track stale-SHA retry behavior: first call rejects, second accepts.
let staleRetryArmed = false
export function armStaleRetry() {
  staleRetryArmed = true
}

const flagsListHandler = http.post(`${getApiBase()}/api/v1/flags/list`, () =>
  HttpResponse.json({json: Object.values(FLAGS)}),
)

const flagsGetByKeyHandler = http.post(`${getApiBase()}/api/v1/flags/getByKey`, async ({request}) => {
  const body = (await request.json()) as any
  const key = body?.json?.flagKey
  const flag = FLAGS[key]
  if (!flag) return HttpResponse.json({json: {message: `Flag ${key} not found`}}, {status: 404})
  return HttpResponse.json({json: flag})
})

const findOrCreateHandler = http.post(`${getApiBase()}/api/v1/flags/findOrCreateOverride`, async ({request}) => {
  const body = (await request.json()) as any
  lastFindOrCreateInput = body?.json
  findOrCreateCallCount += 1

  const key = lastFindOrCreateInput?.flagKey
  if (key === 'feature.stale-once' && staleRetryArmed) {
    staleRetryArmed = false
    return HttpResponse.json(
      {
        json: {
          message: 'feature-flags/feature.stale-once.json was modified (expected sha-stale, got sha-fresh)',
        },
      },
      {status: 409},
    )
  }

  return HttpResponse.json({json: {commitSha: 'sha-after-write'}})
})

const removeHandler = http.post(`${getApiBase()}/api/v1/flags/removeOverride`, async ({request}) => {
  const body = (await request.json()) as any
  lastRemoveInput = body?.json
  removeCallCount += 1
  return HttpResponse.json({json: {commitSha: 'sha-after-remove'}})
})

export const server = setupServer(flagsListHandler, flagsGetByKeyHandler, findOrCreateHandler, removeHandler)
