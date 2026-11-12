import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {resetSchemaStore, schemaUpdateCapture, server} from '../responses/schema.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const createdSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  description: 'Created through the CLI',
  properties: {
    name: {type: 'string'},
  },
  title: 'Created schema',
  type: 'object',
}

const updatedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  description: 'Updated through the CLI',
  properties: {
    count: {type: 'integer'},
    enabled: {type: 'boolean'},
  },
  title: 'Existing schema',
  type: 'object',
}

describe('schema', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })

  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    resetSchemaStore()
  })

  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['schema', 'my.schema', '--get'])
    .it('returns a schema document by key', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.deep.equal({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        description: 'Schema returned by the get command',
        properties: {
          enabled: {type: 'boolean'},
        },
        title: 'My schema',
        type: 'object',
      })
    })

  test
    .stdout()
    .command([
      'schema',
      'created.schema',
      `--set-json-schema=${JSON.stringify(createdSchema)}`,
      '--protected',
      '--json',
    ])
    .it('creates a protected schema document', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.deep.equal({
        commitSha: '0000000000000000000000000000000000000011',
        key: 'created.schema',
        protected: true,
        schema: createdSchema,
      })
    })

  test
    .stdout()
    .command([
      'schema',
      'existing.schema',
      `--set-json-schema=${JSON.stringify(updatedSchema)}`,
      '--protected',
      '--json',
    ])
    .it('updates an existing schema document and can move it to protected storage', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.deep.equal({
        commitSha: '0000000000000000000000000000000000000011',
        key: 'existing.schema',
        protected: true,
        schema: updatedSchema,
      })
    })

  // qfg-2o7ms: omitting --protected on an update must leave the schema's
  // tier alone. The CLI used to send an explicit `protected: false`, which
  // the server honors by moving schemas-protected/x.json to schemas/x.json.
  test
    .stdout()
    .command(['schema', 'protected.schema', `--set-json-schema=${JSON.stringify(updatedSchema)}`, '--json'])
    .it('keeps a protected schema protected when --protected is omitted on update', (ctx) => {
      expect(schemaUpdateCapture.input, 'schemas/update was never called').to.not.be.null
      expect(schemaUpdateCapture.input, 'no protected key on the wire').to.not.have.property('protected')
      expect(JSON.parse(ctx.stdout).protected).to.equal(true)
    })

  test
    .stdout()
    .command([
      'schema',
      'protected.schema',
      `--set-json-schema=${JSON.stringify(updatedSchema)}`,
      '--no-protected',
      '--json',
    ])
    .it('--no-protected moves a protected schema to standard storage', (ctx) => {
      expect(schemaUpdateCapture.input!.protected).to.equal(false)
      expect(JSON.parse(ctx.stdout).protected).to.equal(false)
    })

  test
    .stdout()
    .command(['schema', 'brand-new.schema', `--set-json-schema=${JSON.stringify(createdSchema)}`, '--json'])
    .it('creates a standard schema when --protected is omitted', (ctx) => {
      expect(JSON.parse(ctx.stdout).protected).to.equal(false)
    })

  test
    .command(['schema', 'invalid.schema', '--set-json-schema=not-json'])
    .catch((error) => {
      expect(error.message).to.contain('Schema documents must be valid JSON Schema objects')
    })
    .it('rejects invalid schema JSON', () => {
      // Error assertion done in catch block
    })
})
