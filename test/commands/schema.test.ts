import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/schema.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('schema', () => {
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

  describe('get', () => {
    test
      .stdout()
      .command(['schema', 'my.schema', '--get'])
      .it('can get a schema', (ctx) => {
        expect(ctx.stdout).to.contain('Schema for: my.schema is z.object({url: z.string()})')
      })

    test
      .stdout()
      .command(['schema', 'my.schema', '--get', '--json'])
      .it('can get a schema and return JSON', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output.rows[0].values[0].value.schema.schema).to.equal('z.object({url: z.string()})')
      })

    test
      .command(['schema', 'non.existent.schema', '--get'])
      .catch((error) => {
        expect(error.message).to.contain('Failed to get schema')
      })
      .it('handles non-existent schema', () => {
        // Error assertion done in catch block
      })
  })

  describe('set-zod', () => {
    test
      .stdout()
      .command(['schema', 'new.schema', '--set-zod=z.string()'])
      .it('can create a new schema', (ctx) => {
        expect(ctx.stdout).to.contain('Created schema: new.schema')
      })

    test
      .stdout()
      .command(['schema', 'existing.schema', '--set-zod=z.number()'])
      .it('can update an existing schema', (ctx) => {
        expect(ctx.stdout).to.contain('Updated schema: existing.schema')
      })

    test
      .stdout()
      .command(['schema', 'new.schema', '--set-zod=z.string()', '--json'])
      .it('can create a schema and return JSON', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output).to.have.property('name', 'new.schema')
        expect(output).to.have.property('id')
      })
  })

  test
    .command(['schema', 'my.schema'])
    .catch((error) => {
      expect(error.message).to.contain('No action specified. Try --get or --set-zod')
    })
    .it('requires an action flag', () => {
      // Error assertion done in catch block
    })
})
