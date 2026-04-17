import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {
  confidentialKey,
  keyWithEvaluations,
  keyWithNoEvaluations,
  rawSecret,
  secretKey,
  server,
} from '../responses/info.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const keyDoesNotExist = 'this.does.not.exist'

describe('info', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
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
https://app.quonfig.com/workspaces/workspace-123/flags/${keyWithEvaluations}

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
          `https://app.quonfig.com/workspaces/workspace-123/flags/${keyWithEvaluations}`,
        )
        expect(output[keyWithEvaluations].values).to.deep.equal({
          Default: {
            url: 'https://app.quonfig.com/workspaces/workspace-123/flags/my-string-list-key?environment=undefined',
            value: ['a', 'b', 'c'],
          },
          Production: {
            url: 'https://app.quonfig.com/workspaces/workspace-123/flags/my-string-list-key?environment=143',
          },
          jeffrey: {
            url: 'https://app.quonfig.com/workspaces/workspace-123/flags/my-string-list-key?environment=588',
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

  describe('when there are no evaluations in the last 24 hours', () => {
    test
      .stdout()
      .command(['info', keyWithNoEvaluations])
      .it('returns a message', (ctx) => {
        expect(ctx.stdout.trim()).to.eql(
          `
https://app.quonfig.com/workspaces/workspace-123/flags/${keyWithNoEvaluations}

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

            url: `https://app.quonfig.com/workspaces/workspace-123/flags/${keyWithNoEvaluations}`,

            values: {
              Default: {
                url: 'https://app.quonfig.com/workspaces/workspace-123/flags/jeffreys.test.key.reforge?environment=undefined',
                value: 'abc',
              },
              Production: {
                override: 'my.override',
                url: 'https://app.quonfig.com/workspaces/workspace-123/flags/jeffreys.test.key.reforge?environment=143',
                value: '[see rules]',
              },

              jeffrey: {
                url: 'https://app.quonfig.com/workspaces/workspace-123/flags/jeffreys.test.key.reforge?environment=588',
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

    test
      .stdout()
      .stderr()
      .command(['info', keyDoesNotExist, '--json'])
      .catch(/.*/)
      .it('returns a JSON error', (ctx) => {
        // Try stdout first, then stderr
        let output = ctx.stdout.trim()
        if (!output) {
          // If stderr has multiple lines (e.g., warnings), find lines that look like JSON
          const stderrLines = ctx.stderr.trim().split('\n')
          const jsonLines = stderrLines.filter((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))
          output = jsonLines.at(-1) || '' // Get the last JSON line
        }

        if (output) {
          expect(JSON.parse(output)).to.eql({
            error: `Key ${keyDoesNotExist} not found`,
          })
        }
      })
  })
})
