/**
 * `--propose` / `--cr <n>` and the 403 propose hint on set-default,
 * set-rollout and log-level --target (qfg-5bjew.37, change requests step 3).
 * Command tests run dist/: `yarn build` first.
 */

import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'

import {getAppUrl} from '../../src/util/domain-urls.js'
import {resetClientCache} from '../../src/util/get-client.js'
import {flagsUpdateCapture, logLevelsUpdateCapture, server} from '../responses/set-default.js'
import {
  CR_HEAD_SHA,
  PROPOSE_WS,
  crDetail,
  orpcErr,
  proposeCaptured,
  proposeHandlers,
  resetProposeCaptured,
} from '../responses/propose.js'
import {getApiBase} from '../test-domain-helper.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const SERVER_TOO_OLD =
  'The server did not open a change request (it may be older than this CLI). Nothing is proposed and nothing went live.'

// The FAKE 64-hex test key test/commands/set-default.test.ts uses; the
// robocop-secret fixture's ciphertext was encrypted with it.
const TEST_ENCRYPTION_KEY = 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221'

const crUrl = (n: number) => `${getAppUrl()}/workspaces/${PROPOSE_WS}/change-requests/${n}`

const SIMPLE_FLAG_AFTER = {
  key: 'feature-flag.simple',
  type: 'feature_flag',
  valueType: 'bool',
  environments: [{id: 'Staging', rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}]}],
  default: {rules: [{criteria: [], value: {type: 'bool', value: false}}]},
}

const forbidden = (path: string, message: string) => () =>
  server.use(
    http.post(`${getApiBase()}/api/v1/${path}`, () =>
      HttpResponse.json({json: {code: 'FORBIDDEN', status: 403, message}}, {status: 403}),
    ),
  )

describe('--propose on update commands (qfg-5bjew.37)', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  beforeEach(() => {
    flagsUpdateCapture.body = null
    logLevelsUpdateCapture.body = null
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

  describe('set-default --propose', () => {
    test
      .add('handlers', () => server.use(...proposeHandlers()))
      .stdout()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--propose'])
      .it('sends a set_document with the read commitSha instead of the update route; prints NOT LIVE', (ctx) => {
        expect(flagsUpdateCapture.body, 'flags/update must not be called').to.equal(null)
        expect(proposeCaptured.propose).to.have.length(1)
        const sent = proposeCaptured.propose[0]
        expect(sent.workspaceId).to.equal(PROPOSE_WS)
        expect(sent).to.not.have.property('changeRequest')
        expect(sent.changes).to.have.length(1)
        const change = sent.changes[0]
        expect(change.op).to.equal('set_document')
        expect(change.type).to.equal('flag')
        expect(change.key).to.equal('feature-flag.simple')
        expect(change.expectedCommitSha).to.equal('abc001')
        expect(change.document).to.not.have.property('commitSha')
        expect(change.document.key).to.equal('feature-flag.simple')
        expect(change.document.type).to.equal('feature_flag')
        // Seeded from default.rules (fallback spelled `criteria: []`), as the live write does.
        expect(change.document.environments).to.deep.equal([
          {id: 'Development', rules: [{criteria: [], value: {type: 'bool', value: true}}]},
        ])
        expect(ctx.stdout.split('\n')).to.include.members([
          `  ${crUrl(9)}`,
          'NOT LIVE',
          'Check on it: qfg cr show 9 / Wait: qfg cr wait 9',
        ])
        expect(ctx.stdout).to.contain('Opened change request #9.')
      })

    test
      .add('handlers', () => server.use(...proposeHandlers()))
      .stdout()
      .command([
        'set-default',
        'feature-flag.simple',
        '--environment=Development',
        '--value=true',
        '--propose',
        '--title=Turn it on',
        '--description=For beta',
        '--json',
      ])
      .it('--json gives {proposed, applied: false, changeRequest} and sends title/description', (ctx) => {
        const out = JSON.parse(ctx.stdout)
        expect(out.proposed).to.equal(true)
        expect(out.applied).to.equal(false)
        expect(out.changeRequest.number).to.equal(9)
        expect(out.changeRequest.url).to.equal(crUrl(9))
        expect(out.changeRequest.branch).to.equal('cr/9')
        expect(proposeCaptured.propose[0].title).to.equal('Turn it on')
        expect(proposeCaptured.propose[0].description).to.equal('For beta')
      })

    test
      .add('handlers', () =>
        server.use(...proposeHandlers({propose: () => HttpResponse.json({json: {applied: false}})})),
      )
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--propose'])
      .catch((error) => {
        expect(error.message).to.equal(SERVER_TOO_OLD)
      })
      .it('fails when the response carries no changeRequest.number')

    test
      .add('handlers', () =>
        server.use(
          ...proposeHandlers({
            propose: () => HttpResponse.json({json: {code: 'NOT_FOUND', status: 404}}, {status: 404}),
          }),
        ),
      )
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--propose'])
      .catch((error) => {
        expect(error.message).to.equal(SERVER_TOO_OLD)
      })
      .it('an old server (route 404s) reads as "server too old", not success')

    test
      .add('handlers', () =>
        server.use(
          ...proposeHandlers({
            propose: () => orpcErr(409, 'CONFLICT', 'feature-flags/feature-flag.simple.json changed since abc001'),
          }),
        ),
      )
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--propose'])
      .catch((error) => {
        expect(error.message).to.equal(
          'Failed to propose: 409: feature-flags/feature-flag.simple.json changed since abc001',
        )
      })
      .it('a refused proposal prints the server message')

    test
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--title=x'])
      .catch((error) => {
        expect(error.message).to.equal('--title and --description need --propose (or --cr <n>)')
      })
      .it('--title without --propose is refused')

    // Rule 3.4: a secret keeps encrypting locally, so the proposal carries
    // ciphertext with decryptWith and the plaintext never leaves the machine.
    test
      .env({QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY})
      .add('handlers', () => server.use(...proposeHandlers()))
      .stdout()
      .stderr()
      .command(['set-default', 'robocop-secret', '--environment=Staging', '--value=hunter2', '--propose', '--json'])
      .it('--propose on an encrypted config sends ciphertext, never the plaintext', (ctx) => {
        expect(proposeCaptured.propose).to.have.length(1)
        const change = proposeCaptured.propose[0].changes[0]
        expect(change.op).to.equal('set_document')
        const env = change.document.environments.find((e: {id: string}) => e.id === 'Staging')
        const {value} = env.rules.at(-1)
        expect(value.decryptWith).to.be.a('string').and.not.equal('')
        expect(value.value).to.be.a('string').and.not.equal('hunter2')
        expect(JSON.stringify(proposeCaptured.propose)).to.not.contain('hunter2')
        expect(ctx.stdout).to.not.contain('hunter2')
        expect(ctx.stderr).to.not.contain('hunter2')
        expect(JSON.parse(ctx.stdout).proposed).to.equal(true)
      })
  })

  describe('set-default --cr <n>', () => {
    test
      .add('handlers', () => server.use(...proposeHandlers({detail: crDetail()})))
      .stdout()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--cr=7'])
      .it('reads #7; key not in it: builds from main with the main token and adds to #7', (ctx) => {
        expect(proposeCaptured.get).to.deep.equal([{workspaceId: PROPOSE_WS, number: 7}])
        const sent = proposeCaptured.propose[0]
        expect(sent.changeRequest).to.equal(7)
        expect(sent.changes[0].op).to.equal('set_document')
        expect(sent.changes[0].expectedCommitSha).to.equal('abc001')
        expect(ctx.stdout).to.contain('Added to change request #7.')
        expect(ctx.stdout).to.contain('Check on it: qfg cr show 7 / Wait: qfg cr wait 7')
      })

    test
      .add('handlers', () =>
        server.use(
          ...proposeHandlers({
            detail: crDetail([
              {path: 'feature-flags/feature-flag.simple.json', after: JSON.stringify(SIMPLE_FLAG_AFTER, null, 2)},
            ]),
          }),
        ),
      )
      .stdout()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--cr=7'])
      .it('key already in #7: sends the semantic set_flag with the branch head as token', () => {
        const sent = proposeCaptured.propose[0]
        expect(sent.changeRequest).to.equal(7)
        expect(sent.changes).to.deep.equal([
          {
            op: 'set_flag',
            key: 'feature-flag.simple',
            environment: 'Development',
            value: true,
            expectedCommitSha: CR_HEAD_SHA,
          },
        ])
      })

    test
      .add('handlers', () => server.use(...proposeHandlers()))
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--cr=404'])
      .catch((error) => {
        expect(error.message).to.equal('Change request #404 not found in this workspace.')
        expect(proposeCaptured.propose).to.have.length(0)
      })
      .it('an unknown #n fails before proposing')

    test
      .add('handlers', () =>
        server.use(...proposeHandlers({detail: crDetail([], {status: 'merged', merged: {at: null, by: null}})})),
      )
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--cr=7'])
      .catch((error) => {
        expect(error.message).to.equal(
          'Change request #7 is merged; nothing can be added to it. Propose a new one with --propose.',
        )
      })
      .it('a merged #n is refused before proposing')
  })

  describe('set-rollout --propose / --cr', () => {
    test
      .add('handlers', () => server.use(...proposeHandlers()))
      .stdout()
      .command(['set-rollout', 'feature-flag.simple', '--environment=Development', '--true-percent=20', '--propose'])
      .it('sends a set_document built exactly like the live write', (ctx) => {
        expect(flagsUpdateCapture.body).to.equal(null)
        const change = proposeCaptured.propose[0].changes[0]
        expect(change.op).to.equal('set_document')
        expect(change.type).to.equal('flag')
        expect(change.expectedCommitSha).to.equal('abc001')
        const rule = change.document.environments[0].rules.at(-1)
        expect(rule.value.type).to.equal('weighted_values')
        expect(ctx.stdout).to.contain('NOT LIVE')
      })

    test
      .add('handlers', () =>
        server.use(
          ...proposeHandlers({
            detail: crDetail([
              {path: 'feature-flags/feature-flag.simple.json', after: JSON.stringify(SIMPLE_FLAG_AFTER, null, 2)},
            ]),
            propose: () =>
              orpcErr(
                409,
                'CONFLICT',
                'Flag feature-flag.simple is already changed in change request #7, so set_document cannot revise it there.',
                {reason: 'ChangedInChangeRequest', number: 7, changeIndex: 0},
              ),
          }),
        ),
      )
      .stdout()
      .stderr()
      .command(['set-rollout', 'feature-flag.simple', '--environment=Development', '--true-percent=20', '--cr=7'])
      .catch((error) => {
        expect(proposeCaptured.propose[0].changes[0].expectedCommitSha).to.equal(CR_HEAD_SHA)
        expect(proposeCaptured.propose[0].changes[0].document.environments[0].id).to.equal('Staging')
        expect(error.message).to.equal(
          'feature-flag.simple is already changed in change request #7, and this command cannot revise it there. Close it (qfg cr close 7) and propose again with all of your changes.',
        )
      })
      .it('key already in #7: builds from #7 with the head token; surfaces the refusal in CLI terms')
  })

  describe('log-level --target --propose', () => {
    test
      .add('handlers', () => server.use(...proposeHandlers()))
      .stdout()
      .command(['log-level', 'log-level.test-app', '--target=New.Logger', '--value=ERROR', '--propose'])
      .it('sends a log-level set_document', () => {
        expect(logLevelsUpdateCapture.body).to.equal(null)
        const change = proposeCaptured.propose[0].changes[0]
        expect(change.op).to.equal('set_document')
        expect(change.type).to.equal('log-level')
        expect(change.key).to.equal('log-level.test-app')
        expect(change.document.default.rules[0].criteria[0].valueToMatch.value).to.deep.equal(['New.Logger'])
      })
  })

  describe('403 propose hint', () => {
    const MESSAGE = 'Environment "Development" is protected; editing its rules requires config.edit.protected.'

    test
      .add('forbidden', forbidden('flags/update', MESSAGE))
      .stdout()
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
      .catch((error) => {
        expect(error.message.split('\n')).to.deep.equal([
          `Failed to change default: 403: ${MESSAGE}`,
          'You can propose this change instead; someone with rights merges it:',
          '  qfg set-default feature-flag.simple --environment=Development --value=true --confirm --propose',
        ])
      })
      .it('set-default prints the same command with --propose')

    test
      .add('forbidden', forbidden('flags/update', MESSAGE))
      .stdout()
      .command([
        'set-default',
        'feature-flag.simple',
        '--environment=Development',
        '--value=true',
        '--confirm',
        '--json',
      ])
      .catch(() => {})
      .it('set-default --json gains proposable and proposeCommand', (ctx) => {
        const out = JSON.parse(ctx.stdout)
        expect(out.error.proposable).to.equal(true)
        expect(out.error.proposeCommand).to.equal(
          'qfg set-default feature-flag.simple --environment=Development --value=true --confirm --json --propose',
        )
      })

    test
      .env({QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY})
      .add('forbidden', forbidden('configs/update', MESSAGE))
      .stdout()
      .stderr()
      .command(['set-default', 'robocop-secret', '--environment=Staging', '--value=hunter2', '--confirm'])
      .catch((error) => {
        expect(error.message).to.not.contain('hunter2')
        expect(error.message).to.contain(
          'qfg set-default robocop-secret --environment=Staging --value=<value> --confirm --propose',
        )
      })
      .it('set-default never echoes a secret value in the hint')

    test
      .add('forbidden', forbidden('flags/update', MESSAGE))
      .stdout()
      .stderr()
      .command(['set-rollout', 'feature-flag.simple', '--environment=Development', '--true-percent=20', '--confirm'])
      .catch((error) => {
        expect(error.message.split('\n').slice(1)).to.deep.equal([
          'You can propose this change instead; someone with rights merges it:',
          '  qfg set-rollout feature-flag.simple --environment=Development --true-percent=20 --confirm --propose',
        ])
      })
      .it('set-rollout prints the same command with --propose')

    test
      .add('forbidden', forbidden('logLevels/update', MESSAGE))
      .stdout()
      .stderr()
      .command(['log-level', 'log-level.test-app', '--target=New.Logger', '--value=ERROR'])
      .catch((error) => {
        expect(error.message.split('\n')).to.deep.equal([
          `Failed to update log level: 403: ${MESSAGE}`,
          'You can propose this change instead; someone with rights merges it:',
          '  qfg log-level log-level.test-app --target=New.Logger --value=ERROR --propose',
        ])
      })
      .it('log-level prints the same command with --propose')
  })
})
