import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('set-default', () => {
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

  describe('success', () => {
    test
      .stdout()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
      .it('can change the default for a boolean flag', (ctx) => {
        expect(ctx.stdout).to.contain('Successfully changed default to `true`')
      })

    test
      .stdout()
      .command([
        'set-default',
        'feature-flag.simple',
        '--environment=Development',
        '--value=true',
        '--confirm',
        '--json',
      ])
      .it('can change the default for a boolean flag with json output', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          environment: {
            id: '5',
            name: 'Development',
          },
          key: 'feature-flag.simple',
          success: true,
          value: 'true',
        })
      })

    test
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=[default]',
        '--value=hello default world',
        '--confirm',
      ])
      .it('can change the default for a string flag', (ctx) => {
        expect(ctx.stdout).to.contain('Successfully changed default to `hello default world`')
      })

    test
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=[default]',
        '--confirm',
        '--value=hello default world',
        '--json',
      ])
      .it('can change the default for a string flag with json output', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          environment: {
            id: '',
            name: '[Default]',
          },
          key: 'jeffreys.test.key.reforge',
          success: true,
          value: 'hello default world',
        })
      })

    test
      .stdout()
      .command(['set-default', 'jeffreys.test.key.reforge', '--environment=Staging', '--confirm', '--env-var=GREETING'])
      .it('can create a string provided by an env var', (ctx) => {
        expect(ctx.stdout).to.contain(`Successfully changed default to be provided by \`GREETING\``)
      })

    test
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=Staging',
        '--confirm',
        '--secret',
        '--value=hello',
      ])
      .it('can create a secret string', (ctx) => {
        expect(ctx.stdout).to.contain(`Successfully changed default to \`hello\` (encrypted)`)
      })

    test
      .stdout()
      .command(['set-default', 'robocop-secret', '--environment=Staging', '--confirm', '--value=hello'])
      .it('uses encryption if any existing value for the key is encrypted', (ctx) => {
        expect(ctx.stdout).to.match(/Successfully changed default.*encrypted/)
      })

    test
      .stdout()
      .command(['set-default', 'test.json', '--environment=Staging', '--confirm', '--value={"hello":"world"}'])
      .it('can update a json config', (ctx) => {
        expect(ctx.stdout).to.contain(`Successfully changed default to \`{"hello":"world"}\``)
      })
  })

  describe('failure', () => {
    test
      .stderr()
      .command(['set-default', 'this.does.not.exist', '--environment=Staging', '--value=hello default world'])
      .catch((error) => {
        expect(error.message).to.contain(`Could not find config named this.does.not.exist`)
      })
      .it('shows an error when the key does not exist', () => {
        // Error assertion done in catch block
      })

    test
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=cake', '--confirm'])
      .catch((error) => {
        expect(error.message).to.contain(`'cake' is not a valid value for feature-flag.simple`)
      })
      .it("shows an error when the value isn't valid for the boolean key", () => {
        // Error assertion done in catch block
      })

    test
      .stdout()
      .command(['set-default', 'jeffreys.test.int', '--environment=[default]', '--confirm', '--value=hello'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for int: hello`)
      })
      .it("shows an error when the value isn't valid for the int key", () => {
        // Error assertion done in catch block
      })
  })

  describe('parsing errors', () => {
    test
      .command(['set-default', '--no-interactive'])
      .catch((error) => {
        expect(error.message).to.eql("'name' argument is required when interactive mode isn't available.")
      })
      .it("shows an error if no key is provided when things aren't interactive", () => {
        // Error assertion done in catch block
      })

    test
      .command(['set-default', 'feature-flag.simple', '--no-interactive'])
      .catch((error) => {
        expect(error.message).to.eql("'environment' is required when interactive mode isn't available.")
      })
      .it("shows an error if no environment is provided when things aren't interactive", () => {
        // Error assertion done in catch block
      })

    test
      .stderr()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=Staging',
        '--confirm',
        '--env-var=GREETING',
        '--value=hello world',
      ])
      .catch((error) => {
        expect(error.message).to.contain(`cannot specify both --env-var and --value`)
      })
      .it('shows an error when provided a value and an env-var', () => {
        // Error assertion done in catch block
      })
  })
})
