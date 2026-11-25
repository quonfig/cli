/**
 * `set-default --cr <n>` decides confidentiality and the old-format refusal
 * from the document the write is based on: change request #n's version of
 * the key when #n already changes it (bead qfg-mol-hle PR 3b, validator B1).
 */
import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {crDetail, proposeCaptured, proposeHandlers, resetProposeCaptured} from '../responses/propose.js'
import {server} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const KEY = 'jeffreys.test.key.reforge' // on main: a plain, non-confidential string config
const PLAINTEXT = 'FAKE-CR-PLAINTEXT-7781-zz'
const inCr = (value: Record<string, unknown>) =>
  JSON.stringify(
    {
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value}]},
      environments: [],
      key: KEY,
      type: 'config',
      valueType: 'string',
    },
    null,
    2,
  )

describe('set-default --cr reads the change request version of the key (qfg-mol-hle B1)', () => {
  before(() => {
    setupTestAuth()
    server.listen({onUnhandledRequest: 'error'})
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    resetProposeCaptured()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .add('handlers', () =>
      server.use(
        ...proposeHandlers({
          detail: crDetail([
            {after: inCr({confidential: true, type: 'string', value: 'cr-only-secret'}), path: `configs/${KEY}.json`},
          ]),
        }),
      ),
    )
    .stdout()
    .stderr()
    .command(['set-default', KEY, '--environment=Development', `--value=${PLAINTEXT}`, '--cr=7'])
    .it('confidential only in #7: the new value is proposed confidential and never echoed', (ctx) => {
      const sent = JSON.stringify(proposeCaptured.propose)
      expect(ctx.stdout + ctx.stderr).to.not.contain(PLAINTEXT)
      const change = proposeCaptured.propose[0].changes[0]
      const rules = change.document.environments.find((e: {id: string}) => e.id === 'Development').rules
      expect(rules.at(-1).value).to.deep.equal({confidential: true, type: 'string', value: PLAINTEXT})
      expect(sent.split(PLAINTEXT)).to.have.length(2) // only inside the confidential value
    })

  test
    .add('handlers', () =>
      server.use(
        ...proposeHandlers({
          detail: crDetail([
            {
              after: inCr({
                confidential: true,
                decryptWith: 'quonfig.secrets.encryption.key',
                type: 'string',
                value: 'aaaa--bbbbbbbbbbbbbbbbbbbbbbbb--cccccccccccccccccccccccccccccccc',
              }),
              path: `configs/${KEY}.json`,
            },
          ]),
        }),
      ),
    )
    .stdout()
    .stderr()
    .command(['set-default', KEY, '--environment=Development', `--value=${PLAINTEXT}`, '--cr=7'])
    .catch((error) => {
      expect(error.message).to.match(new RegExp(`^${KEY.replaceAll('.', '\\.')} holds old-format encrypted values`))
      expect(error.message).to.not.contain(PLAINTEXT)
    })
    .it('old-format only in #7: refused, and the plaintext is never proposed', (ctx) => {
      expect(proposeCaptured.propose).to.have.length(0)
      expect(ctx.stdout + ctx.stderr).to.not.contain(PLAINTEXT)
    })
})
