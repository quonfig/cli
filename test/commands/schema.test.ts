import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {resetSchemaStore, server} from '../responses/schema.js'
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
    .command(['schema', 'created.schema', `--set-json-schema=${JSON.stringify(createdSchema)}`, '--protected', '--json'])
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
    .command(['schema', 'existing.schema', `--set-json-schema=${JSON.stringify(updatedSchema)}`, '--protected', '--json'])
    .it('updates an existing schema document and can move it to protected storage', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.deep.equal({
        commitSha: '0000000000000000000000000000000000000011',
        key: 'existing.schema',
        protected: true,
        schema: updatedSchema,
      })
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
