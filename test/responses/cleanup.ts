import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock responses for the `qfg cleanup list` + `qfg cleanup status` commands.
 *
 * - `metadata.list` now carries `readyForCleanup` (server change in
 *   app-quonfig/src/lib/orpc/routes/metadata.ts) so the CLI can identify
 *   candidates without N+1 getByKey calls.
 * - `analytics.evalActivity` returns per key+env eval windows for the whole
 *   workspace in one call; `cleanup list` sums across envs client-side.
 * - `analytics.configSparklines` returns all-env data for one key in one
 *   call (used by `qfg cleanup status <key>`).
 */

export const quietFlagKey = 'flag.quiet'
export const activeFlagKey = 'flag.active'
export const variantFlagKey = 'flag.variant'
export const notReadyFlagKey = 'flag.not-ready-yet'
export const nonFlagConfigKey = 'config.not-a-flag'
export const logLevelKey = 'log-level.app'
export const schemaKey = 'schema.order'
// qfg-9kr8: a flag whose fallback carries the older bare `criteria: []`
// spelling, sitting under a real targeting rule. A strict single-ALWAYS_TRUE
// find misses it and reports the TARGETING rule's value as the fallback.
export const bareFallbackFlagKey = 'flag.bare-fallback'

// today's calendar date, used to anchor the sparkline mock so the CLI's
// "today's bucket" arithmetic lines up with the daily grouping.
const today = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

const metadataHandler = http.post(`${getApiBase()}/api/v1/metadata/list`, () =>
  HttpResponse.json({
    json: {
      configs: [
        {
          key: quietFlagKey,
          type: 'feature_flag',
          valueType: 'bool',
          version: 'abc',
          name: 'Quiet Flag',
          description: 'Ready for cleanup, no recent evals',
          readyForCleanup: true,
        },
        {
          key: activeFlagKey,
          type: 'feature_flag',
          valueType: 'bool',
          version: 'def',
          name: 'Active Flag',
          description: 'Ready for cleanup but still being evaluated',
          readyForCleanup: true,
        },
        {
          key: variantFlagKey,
          type: 'feature_flag',
          valueType: 'string',
          version: 'ghi',
          name: 'Variant Flag',
          description: 'String-typed flag marked ready',
          readyForCleanup: true,
        },
        {
          key: notReadyFlagKey,
          type: 'feature_flag',
          valueType: 'bool',
          version: 'jkl',
          name: 'Not Ready',
          description: 'No cleanup marker',
          readyForCleanup: false,
        },
        {
          key: nonFlagConfigKey,
          type: 'config',
          valueType: 'string',
          version: 'mno',
          name: 'Config not flag',
          description: 'Configs cannot be cleanup-marked',
        },
        {key: logLevelKey, type: 'log_level', valueType: 'log_level', version: 'pqr'},
        {key: schemaKey, type: 'schema', valueType: 'json', version: 'stu'},
      ],
    },
  }),
)

const environmentsHandler = http.post(`${getApiBase()}/api/v1/environments/list`, () =>
  HttpResponse.json({
    json: [
      {id: '588', name: 'production', active: true, protected: false},
      {id: '143', name: 'staging', active: true, protected: false},
    ],
  }),
)

// analytics.evalActivity mock (qfg-1nyzs.2). One call returns per key+env
// windows already aggregated server-side; the CLI sums across envs. Rows
// mirror the configSparklines data below so list/status/remove agree:
//   production activeFlag:  today=3, yesterday=10, 5d=50, 20d=200
//   staging    activeFlag:  yesterday=4
//   production variantFlag: yesterday=1, 5d=5
//   staging    variantFlag: 5d=2
//   production config:      20d=7
// quietFlagKey and notReadyFlagKey have no evals anywhere.
export const evalActivityRows = [
  {
    config_key: activeFlagKey,
    environment: 'production',
    last_eval: today,
    evals_24h: 3,
    evals_2d: 13,
    evals_7d: 63,
    evals_30d: 263,
  },
  {
    config_key: activeFlagKey,
    environment: 'staging',
    last_eval: yesterday,
    evals_24h: 0,
    evals_2d: 4,
    evals_7d: 4,
    evals_30d: 4,
  },
  {
    config_key: variantFlagKey,
    environment: 'production',
    last_eval: yesterday,
    evals_24h: 0,
    evals_2d: 1,
    evals_7d: 6,
    evals_30d: 6,
  },
  {
    config_key: variantFlagKey,
    environment: 'staging',
    last_eval: fiveDaysAgo,
    evals_24h: 0,
    evals_2d: 0,
    evals_7d: 2,
    evals_30d: 2,
  },
  {
    config_key: nonFlagConfigKey,
    environment: 'production',
    last_eval: twentyDaysAgo,
    evals_24h: 0,
    evals_2d: 0,
    evals_7d: 0,
    evals_30d: 7,
  },
]

export const evalActivityRequests: Array<{environment?: string}> = []

const evalActivityHandler = http.post(`${getApiBase()}/api/v1/analytics/evalActivity`, async ({request}) => {
  const body = (await request.json()) as {json?: {environment?: string}}
  const environment = body?.json?.environment
  evalActivityRequests.push({environment})
  const rows = environment ? evalActivityRows.filter((r) => r.environment === environment) : evalActivityRows
  return HttpResponse.json({json: {available: true, windowDays: 90, rows}})
})

// configSparklines returns all-env data for one key in one call.
const configSparklinesHandler = http.post(`${getApiBase()}/api/v1/analytics/configSparklines`, async ({request}) => {
  const body = (await request.json()) as {json?: {configKey?: string}}
  const configKey = body?.json?.configKey ?? ''

  if (configKey === quietFlagKey) {
    return HttpResponse.json({json: {daysOfHistory: 60, rows: []}})
  }

  if (configKey === activeFlagKey) {
    return HttpResponse.json({
      json: {
        daysOfHistory: 60,
        rows: [
          {environment: 'production', days: [twentyDaysAgo, fiveDaysAgo, yesterday, today], counts: [200, 50, 10, 3]},
          {environment: 'staging', days: [yesterday], counts: [4]},
        ],
      },
    })
  }

  return HttpResponse.json({json: {daysOfHistory: 60, rows: []}})
})

const getByKeyHandler = http.post(`${getApiBase()}/api/v1/metadata/getByKey`, async ({request}) => {
  const body = (await request.json()) as {json?: {key?: string}}
  const key = body?.json?.key ?? ''

  if (key === quietFlagKey) {
    return HttpResponse.json({
      json: {
        key: quietFlagKey,
        type: 'feature_flag',
        valueType: 'bool',
        readyForCleanup: true,
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}]},
        environments: [],
      },
    })
  }

  if (key === activeFlagKey) {
    return HttpResponse.json({
      json: {
        key: activeFlagKey,
        type: 'feature_flag',
        valueType: 'bool',
        readyForCleanup: true,
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]},
        environments: [
          {
            id: '588',
            rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}],
          },
        ],
      },
    })
  }

  if (key === variantFlagKey) {
    return HttpResponse.json({
      json: {
        key: variantFlagKey,
        type: 'feature_flag',
        valueType: 'string',
        readyForCleanup: true,
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'on'}}]},
        environments: [],
      },
    })
  }

  if (key === bareFallbackFlagKey) {
    return HttpResponse.json({
      json: {
        key: bareFallbackFlagKey,
        type: 'feature_flag',
        valueType: 'bool',
        readyForCleanup: true,
        default: {
          rules: [
            {
              criteria: [
                {
                  operator: 'PROP_IS_ONE_OF',
                  propertyName: 'user.email',
                  valueToMatch: {type: 'string_list', value: ['staff@example.test']},
                },
              ],
              value: {type: 'bool', value: true},
            },
            {criteria: [], value: {type: 'bool', value: false}},
          ],
        },
        environments: [],
      },
    })
  }

  if (key === notReadyFlagKey) {
    return HttpResponse.json({
      json: {
        key: notReadyFlagKey,
        type: 'feature_flag',
        valueType: 'bool',
        readyForCleanup: false,
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}]},
        environments: [],
      },
    })
  }

  return HttpResponse.json({json: {error: 'Not found'}}, {status: 404})
})

export const server = setupServer(
  metadataHandler,
  environmentsHandler,
  evalActivityHandler,
  configSparklinesHandler,
  getByKeyHandler,
)
