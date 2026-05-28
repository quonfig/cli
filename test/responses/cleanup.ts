import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock responses for the `qfg cleanup list` + `qfg cleanup status` commands.
 *
 * - `metadata.list` now carries `readyForCleanup` (server change in
 *   app-quonfig/src/lib/orpc/routes/metadata.ts) so the CLI can identify
 *   candidates without N+1 getByKey calls.
 * - `analytics.sparklines` is per-environment, so the CLI loops over envs
 *   and aggregates client-side. The mock returns deterministic shapes per
 *   (env, key) pair.
 * - `analytics.configSparklines` returns all-env data for one key in one
 *   call (used by `qfg cleanup status <key>`).
 */

export const quietFlagKey = 'flag.quiet'
export const activeFlagKey = 'flag.active'
export const variantFlagKey = 'flag.variant'
export const notReadyFlagKey = 'flag.not-ready-yet'
export const nonFlagConfigKey = 'config.not-a-flag'

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

// Per-env sparkline mock. Per the plan, the CLI calls analytics.sparklines once
// per environment and sums the per-key counts client-side.
//
// Shape produced server-side: { daysOfHistory, rows: [{ config_key, days[], counts[] }] }
const sparklinesHandler = http.post(`${getApiBase()}/api/v1/analytics/sparklines`, async ({request}) => {
  const body = (await request.json()) as {json?: {environment?: string}}
  const env = body?.json?.environment ?? ''

  if (env === 'production') {
    return HttpResponse.json({
      json: {
        daysOfHistory: 60,
        rows: [
          {
            config_key: activeFlagKey,
            days: [twentyDaysAgo, fiveDaysAgo, yesterday, today],
            counts: [200, 50, 10, 3],
          },
          {
            config_key: variantFlagKey,
            days: [fiveDaysAgo, yesterday],
            counts: [5, 1],
          },
        ],
      },
    })
  }

  if (env === 'staging') {
    return HttpResponse.json({
      json: {
        daysOfHistory: 60,
        rows: [
          // quietFlagKey appears nowhere — zero evals everywhere
          {
            config_key: activeFlagKey,
            days: [yesterday],
            counts: [4],
          },
          {
            config_key: variantFlagKey,
            // last_eval was 5d ago, nothing since — under the 2d gate but not 7d
            days: [fiveDaysAgo],
            counts: [2],
          },
        ],
      },
    })
  }

  return HttpResponse.json({json: {daysOfHistory: 60, rows: []}})
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

  return HttpResponse.json({json: {error: 'Not found'}}, {status: 404})
})

export const server = setupServer(
  metadataHandler,
  environmentsHandler,
  sparklinesHandler,
  configSparklinesHandler,
  getByKeyHandler,
)
