import {expect} from 'chai'

import {jsonSchemaToZod} from '../../src/codegen/json-schema-to-zod.js'
import {ZodToStringMapper} from '../../src/codegen/language-mappers/zod-to-string-mapper.js'
import * as introspect from '../../src/codegen/zod-introspection.js'

describe('jsonSchemaToZod', () => {
  it('converts object schemas with enums and literals', () => {
    const schema = jsonSchemaToZod({
      title: 'permissions',
      type: 'object',
      properties: {
        mode: {
          enum: ['warn', 'error'],
        },
        scope: {
          const: 'workspace',
        },
      },
      required: ['mode', 'scope'],
    })

    const rendered = new ZodToStringMapper().resolveType(schema)

    expect(rendered.split(' ').join('')).to.equal(
      'z.object({mode:z.enum([\'warn\',\'error\']);scope:z.literal("workspace")})',
    )
  })

  it('preserves metadata from title and description fields', () => {
    const schema = jsonSchemaToZod({
      title: 'Display title',
      description: 'Human readable description',
      type: 'string',
    })

    expect(introspect.getMetaDescription(schema)).to.equal('Human readable description')
  })
})
