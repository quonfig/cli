import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {
  confidentialKey,
  evaluationStatsRequests,
  jsonKey,
  keyWithEvaluations,
  keyWithMalformedEvals,
  keyWithNoEvaluations,
  rawSecret,
  readyForCleanupKey,
  rolloutRuleKey,
  secretKey,
  server,
} from '../responses/info.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'
import {getAppBase} from '../test-domain-helper.js'

const keyDoesNotExist = 'this.does.not.exist'

describe('info', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    evaluationStatsRequests.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('when there are evaluations in the last 24 hours', () => {
    test
      .stdout()
      .command(['info', keyWithEvaluations])
      .it('returns info for a name', (ctx) => {
        expect(ctx.stdout.trim()).to.eql(
          `
${getAppBase()}/workspaces/workspace-123/flags/${keyWithEvaluations}

- Default: a,b,c
- jeffrey: [inherit]
- Production: [inherit]

Evaluations over the last 24 hours:

Production: 34,789
- 33% - false
- 67% - true

jeffrey: 42
- 100% - "test"
`.trim(),
        )
      })

    test
      .stdout()
      .command(['info', keyWithEvaluations, '--json'])
      .it('returns JSON for a name', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        // Check structure but don't validate exact timestamps
        expect(output[keyWithEvaluations].url).to.equal(
          `${getAppBase()}/workspaces/workspace-123/flags/${keyWithEvaluations}`,
        )
        expect(output[keyWithEvaluations].values).to.deep.equal({
          Default: {
            url: `${getAppBase()}/workspaces/workspace-123/flags/my-string-list-key?environment=undefined`,
            value: ['a', 'b', 'c'],
          },
          Production: {
            url: `${getAppBase()}/workspaces/workspace-123/flags/my-string-list-key?environment=143`,
          },
          jeffrey: {
            url: `${getAppBase()}/workspaces/workspace-123/flags/my-string-list-key?environment=588`,
          },
        })
        expect(output[keyWithEvaluations].evaluations.environments).to.deep.equal([
          {
            counts: [
              {configValue: {bool: false}, count: 11_473},
              {configValue: {bool: true}, count: 23_316},
            ],
            envId: '143',
            name: 'Production',
            total: 34_789,
          },
          {
            counts: [{configValue: {string: 'test'}, count: 42}],
            envId: '588',
            name: 'jeffrey',
            total: 42,
          },
        ])
        expect(output[keyWithEvaluations].evaluations.total).to.equal(34_831)
      })
  })

  // qfg-nkpe: the real evaluationStats endpoint returns ClickHouse rows shaped
  // {selected_value: '{"bool":false}', total: N} — a JSON-encoded STRING and a
  // `total` column. The CLI used to read {selectedValue: {...}, count: N}, so it
  // reported "No evaluations found" even with real data and then threw
  // 'Cannot read properties of undefined (reading bool)'. These tests pin the
  // wire shape; see the matching fixture note in test/responses/info.ts.
  describe('value-summary rendering tolerates malformed/missing eval values (qfg-nkpe)', () => {
    test
      .stdout()
      .command(['info', keyWithMalformedEvals])
      .it('renders details and does not throw when rows lack selected_value', (ctx) => {
        // The flag's core details still render...
        expect(ctx.stdout).to.contain('Default: true')
        // ...and the unparseable value is shown as 'unknown', not a crash.
        expect(ctx.stdout).to.contain('Production: 10')
        expect(ctx.stdout).to.contain('unknown')
        expect(ctx.stdout).to.not.contain('Cannot read properties of undefined')
      })

    test
      .stdout()
      .command(['info', keyWithMalformedEvals, '--json'])
      .it('builds JSON evaluations without throwing on a missing value', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        const env = output[keyWithMalformedEvals].evaluations.environments[0]
        expect(env.name).to.equal('Production')
        expect(env.total).to.equal(10)
        // A row with no selected_value transforms to {} rather than throwing.
        expect(env.counts[0].configValue).to.deep.equal({})
      })
  })

  describe('when there are no evaluations in the last 24 hours', () => {
    test
      .stdout()
      .command(['info', keyWithNoEvaluations])
      .it('returns a message', (ctx) => {
        expect(ctx.stdout.trim()).to.eql(
          `
${getAppBase()}/workspaces/workspace-123/flags/${keyWithNoEvaluations}

- Default: abc
- jeffrey: [see rules]
- Production: [override] \`my.override\`

No evaluations found for the past 24 hours
`.trim(),
        )
      })

    test
      .stdout()
      .command(['info', keyWithNoEvaluations, '--json'])
      .it('returns JSON', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.eql({
          [keyWithNoEvaluations]: {
            evaluations: {
              error: `No evaluations found for the past 24 hours`,
            },

            url: `${getAppBase()}/workspaces/workspace-123/flags/${keyWithNoEvaluations}`,

            values: {
              Default: {
                url: `${getAppBase()}/workspaces/workspace-123/flags/jeffreys.test.key.reforge?environment=undefined`,
                value: 'abc',
              },
              Production: {
                override: 'my.override',
                url: `${getAppBase()}/workspaces/workspace-123/flags/jeffreys.test.key.reforge?environment=143`,
                value: '[see rules]',
              },

              jeffrey: {
                url: `${getAppBase()}/workspaces/workspace-123/flags/jeffreys.test.key.reforge?environment=588`,
                value: '[see rules]',
              },
            },
          },
        })
      })

    test
      .stdout()
      .command(['info', secretKey])
      .it('decrypts a secret', (ctx) => {
        expect(ctx.stdout).not.contains(rawSecret)
        expect(ctx.stdout).contains('Default: [encrypted]')
      })

    test
      .stdout()
      .command(['info', confidentialKey])
      .it('shows [confidential] for confidential items', (ctx) => {
        expect(ctx.stdout).not.contains(rawSecret)
        expect(ctx.stdout).contains('Default: [confidential]')
      })

    test
      .stdout()
      .command(['info', jsonKey])
      .it('renders JSON default as JSON (not [object Object])', (ctx) => {
        expect(ctx.stdout).not.contains('[object Object]')
        expect(ctx.stdout).contains('Default: {"maxTokens":500,"model":"claude"}')
      })

    // qfg-5j9i: env whose conditional rule serves a `weighted_values` rollout
    // used to render as "[override] [object Object]" because formatValue did
    // not unwrap the {type: 'weighted_values', value: {weightedValues: [...]}}
    // shape emitted by the LaunchDarkly migrator.
    test
      .stdout()
      .command(['info', rolloutRuleKey, '--exclude-evaluations'])
      .it('renders [see rules] for an env with a weighted_values rollout (qfg-5j9i)', (ctx) => {
        expect(ctx.stdout).not.contains('[object Object]')
        expect(ctx.stdout).contains('jeffrey: [see rules]')
      })
  })

  // qfg-olm2.6: when a flag is marked readyForCleanup=true, `qfg info` should
  // surface a hint pointing at the cleanup workflow. Agents call `info` often,
  // so this is the highest-leverage discovery surface for the cleanup flow.
  describe('when the flag is marked readyForCleanup=true', () => {
    test
      .stdout()
      .command(['info', readyForCleanupKey, '--exclude-evaluations'])
      .it('appends a cleanup hint to the non-JSON output (qfg-olm2.6)', (ctx) => {
        expect(ctx.stdout).to.contain('This flag is marked for cleanup.')
        expect(ctx.stdout).to.contain(`qfg cleanup status ${readyForCleanupKey}`)
        expect(ctx.stdout).to.contain(`qfg cleanup remove ${readyForCleanupKey}`)
      })

    test
      .stdout()
      .command(['info', readyForCleanupKey, '--exclude-evaluations', '--json'])
      .it('includes readyForCleanup=true in --json output (qfg-olm2.6)', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output[readyForCleanupKey].readyForCleanup).to.equal(true)
      })

    test
      .stdout()
      .command(['info', keyWithNoEvaluations, '--exclude-evaluations'])
      .it('does NOT show the cleanup hint when readyForCleanup is unset (qfg-olm2.6)', (ctx) => {
        expect(ctx.stdout).to.not.contain('This flag is marked for cleanup.')
      })
  })

  describe('analytics request body (qfg-kemk regression)', () => {
    test
      .stdout()
      .command(['info', keyWithEvaluations])
      .it('passes environment NAME (not UUID) to /api/v1/analytics/evaluationStats', () => {
        // Backstop for qfg-kemk: ClickHouse stores environment NAME, so the
        // CLI must send the name. Sending env.id (UUID) silently returns [].
        expect(evaluationStatsRequests.length).to.be.greaterThan(0)
        const sentEnvironments = evaluationStatsRequests.map((r) => r.environment)
        expect(sentEnvironments).to.include('Production')
        expect(sentEnvironments).to.include('jeffrey')
        // And explicitly: no UUID/id values leaked through.
        expect(sentEnvironments).to.not.include('143')
        expect(sentEnvironments).to.not.include('588')
      })
  })

  describe('aliases', () => {
    test
      .stdout()
      .command(['flag:show', keyWithEvaluations])
      .it('supports `flag show` alias', (ctx) => {
        expect(ctx.stdout).to.contain(keyWithEvaluations)
      })

    test
      .stdout()
      .command(['flag:info', keyWithEvaluations])
      .it('supports `flag info` alias', (ctx) => {
        expect(ctx.stdout).to.contain(keyWithEvaluations)
      })
  })

  describe('when the key does not exist', () => {
    test
      .command(['info', keyDoesNotExist])
      .catch((error) => {
        expect(error.message).to.contain(`Key ${keyDoesNotExist} not found`)
      })
      .it('returns a message', () => {
        // Error assertion done in catch block
      })

    // Regression (qfg-hzmb): BaseCommand.catch() used to call `this.log()`,
    // which oclif documents as a no-op whenever jsonEnabled(). A failing
    // `--json` run therefore printed NOTHING on stdout — for an agent, a write
    // failure was indistinguishable from an empty success. The structured
    // envelope must land on stdout, with the real message in it.
    test
      .stdout()
      .stderr()
      .command(['info', keyDoesNotExist, '--json'])
      .catch(/.*/)
      .it('prints a structured JSON error on stdout', (ctx) => {
        expect(ctx.stdout.trim(), 'stdout must not be empty on a --json failure').to.not.equal('')

        const output = JSON.parse(ctx.stdout) as {error: {code: string; exitCode: number; message: string}}
        expect(output.error.message).to.equal(`Key ${keyDoesNotExist} not found`)
        expect(output.error.code).to.equal('ERR')
        expect(output.error.exitCode).to.equal(1)
      })
  })
})
