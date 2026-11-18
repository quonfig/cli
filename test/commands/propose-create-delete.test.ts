/**
 * `--propose` / `--cr <n>` and the 403 propose hint on create, log-level
 * (create mode) and delete (qfg-5bjew.37, change requests step 3). Command
 * tests run dist/: `yarn build` first.
 */

import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'

import {resetClientCache} from '../../src/util/get-client.js'
import * as createResponses from '../responses/create.js'
import * as deleteResponses from '../responses/delete.js'
import {CR_HEAD_SHA, crDetail, proposeCaptured, proposeHandlers, resetProposeCaptured} from '../responses/propose.js'
import {getApiBase} from '../test-domain-helper.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const MESSAGE = 'Creating items requires config.create.'

const forbidden = (server: typeof createResponses.server, path: string) => () =>
  server.use(
    http.post(`${getApiBase()}/api/v1/${path}`, () =>
      HttpResponse.json({json: {code: 'FORBIDDEN', status: 403, message: MESSAGE}}, {status: 403}),
    ),
  )

describe('create --propose (qfg-5bjew.37)', () => {
  const {server} = createResponses
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    createResponses.resetCapturedCreateConfigInput()
    createResponses.resetCapturedLogLevelInputs()
    resetProposeCaptured()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['create', 'my.new.string', '--type=string', '--value=hello', '--propose'])
    .it('a config is proposed as create_config (bare value), never created live', (ctx) => {
      expect(createResponses.capturedCreateConfigInput, 'configs/create must not be called').to.equal(null)
      expect(proposeCaptured.propose[0].changes).to.deep.equal([
        {op: 'create_config', key: 'my.new.string', valueType: 'string', value: 'hello'},
      ])
      expect(ctx.stdout).to.contain('Opened change request #9.')
      expect(ctx.stdout).to.contain('NOT LIVE')
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['create', 'my.list', '--type=string-list', '--value=a,b', '--propose', '--json'])
    .it('a string-list is sent as a bare array; --json is {proposed, applied, changeRequest}', (ctx) => {
      expect(proposeCaptured.propose[0].changes[0]).to.deep.equal({
        op: 'create_config',
        key: 'my.list',
        valueType: 'string_list',
        value: ['a', 'b'],
      })
      const out = JSON.parse(ctx.stdout)
      expect(out).to.include({proposed: true, applied: false})
      expect(out.changeRequest.number).to.equal(9)
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['create', 'my.new.flag', '--type=boolean-flag', '--propose'])
    .it('a boolean flag is proposed as create_flag (created off)', () => {
      expect(proposeCaptured.propose[0].changes).to.deep.equal([{op: 'create_flag', key: 'my.new.flag', type: 'bool'}])
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['create', 'my.new.flag', '--type=boolean-flag', '--value=true', '--propose'])
    .it('a boolean flag created on adds set_flag enabled on the default rules', () => {
      expect(proposeCaptured.propose[0].changes).to.deep.equal([
        {op: 'create_flag', key: 'my.new.flag', type: 'bool'},
        {op: 'set_flag', key: 'my.new.flag', environment: 'default', enabled: true},
      ])
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['create', 'my.new.string', '--type=string', '--value=hello', '--cr=7'])
    .it('--cr <n> adds the create to #n', () => {
      expect(proposeCaptured.propose[0].changeRequest).to.equal(7)
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .stderr()
    .command(['create', 'my.secret', '--secret', '--value=s3cret', '--propose'])
    .catch((error) => {
      expect(error.message).to.not.contain('s3cret')
      expect(error.message).to.equal(
        'qfg create --propose cannot carry --secret, --confidential or --env-var yet: a proposed create stores a plain value. Ask someone who can create items to create it, then propose the value with qfg set-default --propose.',
      )
      expect(proposeCaptured.propose).to.have.length(0)
    })
    .it('--secret --propose on create is refused before anything is sent')

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['create', 'log-level.new-app', '--type=log_level', '--value=WARN', '--propose'])
    .it('a log level is proposed as set_log_level', () => {
      expect(createResponses.capturedLogLevelCreateInput, 'logLevels/create must not be called').to.equal(null)
      expect(proposeCaptured.propose[0].changes).to.deep.equal([
        {op: 'set_log_level', key: 'log-level.new-app', level: 'WARN'},
      ])
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['log-level', 'log-level.new-app', '--value=DEBUG', '--propose', '--title=quiet it'])
    .it('log-level create mode forwards --propose/--title to create', () => {
      expect(proposeCaptured.propose[0].title).to.equal('quiet it')
      expect(proposeCaptured.propose[0].changes).to.deep.equal([
        {op: 'set_log_level', key: 'log-level.new-app', level: 'DEBUG'},
      ])
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .stderr()
    .command(['create', 'log-level.existing', '--type=log_level', '--value=WARN', '--propose'])
    .catch((error) => {
      expect(error.message).to.equal('Failed to create log level: log-level.existing already exists')
      expect(proposeCaptured.propose).to.have.length(0)
    })
    .it('a proposed log-level create of an existing key is refused like the live create')

  test
    .add('forbidden', forbidden(server, 'configs/create'))
    .stdout()
    .stderr()
    .command(['create', 'my.new.string', '--type=string', '--value=hello'])
    .catch((error) => {
      expect(error.message.split('\n')).to.deep.equal([
        `Failed to create config: 403: ${MESSAGE}`,
        'You can propose this change instead; someone with rights merges it:',
        '  qfg create my.new.string --type=string --value=hello --propose',
      ])
    })
    .it('a refused create prints the same command with --propose')

  test
    .add('forbidden', forbidden(server, 'flags/create'))
    .stdout()
    .command(['create', 'my.new.flag', '--type=boolean-flag', '--json'])
    .catch(() => {})
    .it('a refused boolean-flag create: --json gains proposable and proposeCommand', (ctx) => {
      const out = JSON.parse(ctx.stdout)
      expect(out.error.proposable).to.equal(true)
      expect(out.error.proposeCommand).to.equal('qfg create my.new.flag --type=boolean-flag --json --propose')
    })
})

describe('delete --propose (qfg-5bjew.37)', () => {
  const {server} = deleteResponses
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    deleteResponses.resetCaptured()
    resetProposeCaptured()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['delete', 'feature.flag.to-delete', '--propose', '--no-interactive'])
    .it('proposes a delete op with the version read; needs no --yes; nothing deleted live', (ctx) => {
      expect(deleteResponses.flagDeleteCallCount).to.equal(0)
      expect(proposeCaptured.propose[0].changes).to.deep.equal([
        {op: 'delete', type: 'flag', key: 'feature.flag.to-delete', expectedCommitSha: 'sha-flag-current'},
      ])
      expect(ctx.stdout).to.contain('NOT LIVE')
    })

  test
    .add('handlers', () => server.use(...proposeHandlers()))
    .stdout()
    .command(['delete', 'log-level.to-delete', '--propose', '--json'])
    .it('a log level delete; --json is {proposed, applied, changeRequest}', (ctx) => {
      expect(proposeCaptured.propose[0].changes[0]).to.include({op: 'delete', type: 'log-level'})
      expect(JSON.parse(ctx.stdout)).to.include({proposed: true, applied: false})
    })

  test
    .add('handlers', () =>
      server.use(
        ...proposeHandlers({
          detail: crDetail([{path: 'configs/config.to-delete.json', after: '{"key":"config.to-delete"}'}]),
        }),
      ),
    )
    .stdout()
    .command(['delete', 'config.to-delete', '--cr=7'])
    .it('--cr <n> with the key already in #n uses the branch head as token', () => {
      expect(proposeCaptured.propose[0].changeRequest).to.equal(7)
      expect(proposeCaptured.propose[0].changes[0]).to.deep.equal({
        op: 'delete',
        type: 'config',
        key: 'config.to-delete',
        expectedCommitSha: CR_HEAD_SHA,
      })
    })

  test
    .add('forbidden', forbidden(deleteResponses.server, 'flags/delete'))
    .stdout()
    .stderr()
    .command(['delete', 'feature.flag.to-delete', '--yes'])
    .catch((error) => {
      expect(error.message.split('\n')).to.deep.equal([
        `Failed to delete feature.flag.to-delete: 403: ${MESSAGE}`,
        'You can propose this change instead; someone with rights merges it:',
        '  qfg delete feature.flag.to-delete --yes --propose',
      ])
    })
    .it('a refused delete prints the same command with --propose')
})
