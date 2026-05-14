import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {writeQuonfigFiles} from '../../src/migrate/local-write.js'
import {launchSource, __resetLaunchSourceForTests} from '../../src/migrate/sources/launch.js'
import {setLaunchBaseUrl} from '../../src/migrate/sources/launch/api.js'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'
import type {LaunchChangeEntry, LaunchConfig} from '../../src/migrate/sources/launch/types.js'
import type {LegacyChange} from '../../src/migrate/source.js'

// qfg-g4go: When a Launch flag has a multi-change history (e.g. semver-based
// rollout that later completes and is simplified back to ALWAYS_TRUE), the
// migrator must reflect the LATEST state on disk. The bug suspicion was that
// patients.notifications-inbox.enabled had its PROP_SEMVER_GREATER_THAN rules
// silently dropped to ALL ALWAYS_TRUE in 0.0.36 after the qfg-0q1f.4 fix.
// These tests pin down the actual semantics so a real regression cannot hide.

const TEST_BASE_URL = 'https://api.launch.test'
const USER = {email: 'a@b', id: 'u1', type: 'user'}

const buildEnvSnapshot = (
  envId: string,
  rules: LaunchConfig['environments'][0]['rules'],
): LaunchConfig['environments'][0] => ({id: envId, rules})

const fullyRolledOutNotificationsInbox = (): LaunchConfig => ({
  default: {
    rules: [
      {
        criteria: [{operator: 'ALWAYS_TRUE', propertyName: ''}],
        value: {type: 'bool', value: true},
      },
    ],
  },
  environments: [
    buildEnvSnapshot('1', [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]),
    buildEnvSnapshot('2', [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]),
    buildEnvSnapshot('3', [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]),
    buildEnvSnapshot('4', [
      {criteria: [{operator: 'ALWAYS_TRUE', propertyName: ''}], value: {type: 'bool', value: true}},
    ]),
  ],
  id: '17767023594243781',
  key: 'patients.notifications-inbox.enabled',
  projectId: '407',
  type: 'feature_flag',
  valueType: 'bool',
  variants: [{value: {type: 'bool', value: false}}, {value: {type: 'bool', value: true}}],
})

const semverRolloutNotificationsInbox = (): LaunchConfig => ({
  default: {
    rules: [
      {
        criteria: [{operator: 'ALWAYS_TRUE', propertyName: ''}],
        value: {type: 'bool', value: false},
      },
    ],
  },
  environments: [
    buildEnvSnapshot('1', [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]),
    buildEnvSnapshot('2', [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]),
    buildEnvSnapshot('3', [
      {
        criteria: [
          {
            operator: 'PROP_SEMVER_GREATER_THAN',
            propertyName: 'device.appVersion',
            valueToMatch: {type: 'string', value: '4.0.9'},
          },
        ],
        value: {type: 'bool', value: true},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ]),
    buildEnvSnapshot('4', [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}]),
  ],
  id: '17767023594243781',
  key: 'patients.notifications-inbox.enabled',
  projectId: '407',
  type: 'feature_flag',
  valueType: 'bool',
  variants: [{value: {type: 'bool', value: false}}, {value: {type: 'bool', value: true}}],
})

const buildChange = (changedAt: number, newConfig: LaunchConfig): LegacyChange => ({
  changedAt,
  key: 'patients.notifications-inbox.enabled',
  raw: {
    changedAt,
    changedBy: USER,
    deleted: false,
    key: 'patients.notifications-inbox.enabled',
    newConfig,
    newConfigId: changedAt,
    type: 'FEATURE_FLAG',
  } as LaunchChangeEntry,
  source: 'launch',
})

describe('migrate/multi-change history — latest change wins (qfg-g4go)', () => {
  let server: ReturnType<typeof setupServer>
  let dir: string

  beforeEach(async () => {
    setLaunchBaseUrl(TEST_BASE_URL)
    __resetLaunchSourceForTests()
    server = setupServer(
      http.get(`${TEST_BASE_URL}/api/v1/project-environments`, () =>
        HttpResponse.json({
          envs: [
            {id: 1, name: 'development'},
            {id: 2, name: 'staging'},
            {id: 3, name: 'production'},
            {id: 4, name: 'test'},
          ],
          projectId: 407,
        }),
      ),
    )
    server.listen({onUnhandledRequest: 'error'})
    await launchSource.validateAuth('test-key')
    await launchSource.listEnvironments()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-g4go-'))
  })

  afterEach(() => {
    server.close()
    fs.rmSync(dir, {force: true, recursive: true})
  })

  it('writes the LATEST change to disk even when intermediate changes carry semver rules', () => {
    const changes: LegacyChange[] = [
      buildChange(100, semverRolloutNotificationsInbox()),
      buildChange(200, semverRolloutNotificationsInbox()),
      buildChange(300, semverRolloutNotificationsInbox()),
      buildChange(400, semverRolloutNotificationsInbox()),
      buildChange(500, semverRolloutNotificationsInbox()),
      buildChange(600, fullyRolledOutNotificationsInbox()),
    ]

    writeQuonfigFiles(dir, changes, launchSource)

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'feature-flags/patients.notifications-inbox.enabled.json'), 'utf8'),
    )

    const productionEnv = (written.environments as Array<{id: string; rules: unknown[]}>).find(
      (e) => e.id === 'production',
    )
    expect(productionEnv).to.not.equal(undefined)
    expect(productionEnv!.rules).to.have.length(1)
    const productionRule = productionEnv!.rules[0] as {
      criteria: Array<{operator: string}>
      value: {value: unknown}
    }
    expect(productionRule.criteria[0].operator).to.equal('ALWAYS_TRUE')
    expect(productionRule.value.value).to.equal(true)
  })

  it('preserves semver rules when the LATEST change still carries them', () => {
    const changes: LegacyChange[] = [
      buildChange(100, fullyRolledOutNotificationsInbox()),
      buildChange(200, semverRolloutNotificationsInbox()),
    ]

    writeQuonfigFiles(dir, changes, launchSource)

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'feature-flags/patients.notifications-inbox.enabled.json'), 'utf8'),
    )

    const productionEnv = (written.environments as Array<{id: string; rules: unknown[]}>).find(
      (e) => e.id === 'production',
    )
    expect(productionEnv).to.not.equal(undefined)
    expect(productionEnv!.rules).to.have.length(2)
    const semverRule = productionEnv!.rules[0] as {
      criteria: Array<{operator: string; propertyName?: string}>
    }
    expect(semverRule.criteria[0].operator).to.equal('PROP_SEMVER_GREATER_THAN')
    expect(semverRule.criteria[0].propertyName).to.equal('device.appVersion')
  })

  it('writes a semver criterion verbatim into the on-disk JSON', () => {
    const changes: LegacyChange[] = [buildChange(100, semverRolloutNotificationsInbox())]
    writeQuonfigFiles(dir, changes, launchSource)
    const raw = fs.readFileSync(path.join(dir, 'feature-flags/patients.notifications-inbox.enabled.json'), 'utf8')
    expect(raw).to.match(/PROP_SEMVER_GREATER_THAN/)
    expect(raw).to.match(/device\.appVersion/)
    expect(raw).to.match(/4\.0\.9/)
  })
})
