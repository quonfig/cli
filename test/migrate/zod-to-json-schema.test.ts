import {expect} from 'chai'

import {zodToJsonSchema} from '../../src/migrate/sources/launch/zod-to-json-schema.js'

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

describe('zodToJsonSchema (inline)', () => {
  it('converts a simple object with required string', () => {
    const result = zodToJsonSchema('z.object({ name: z.string() })')
    expect(result.warnings).to.deep.equal([])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      properties: {name: {type: 'string'}},
      required: ['name'],
      type: 'object',
    })
  })

  it('handles meta({description}) and records ignored meta fields', () => {
    const result = zodToJsonSchema(
      'z.object({\n  count: z.number().meta({ description: "Count", custom: 1 })\n})',
    )
    expect(result.warnings).to.deep.equal(['Ignored unsupported meta field "custom"'])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      properties: {
        count: {description: 'Count', type: 'number'},
      },
      required: ['count'],
      type: 'object',
    })
  })

  it('rejects unsupported Zod surface explicitly', () => {
    expect(() => zodToJsonSchema('z.any()')).to.throw('Unsupported base Zod call: any')
  })

  it('converts .nullable() into type array with null', () => {
    const result = zodToJsonSchema('z.object({ timeout: z.number().nullable() })')
    expect(result.warnings).to.deep.equal([])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      properties: {timeout: {type: ['number', 'null']}},
      required: ['timeout'],
      type: 'object',
    })
  })

  it('tolerates .nullable without parens (common hand-written typo)', () => {
    const result = zodToJsonSchema('z.object({ name: z.string().nullable })')
    expect(result.warnings).to.deep.equal([])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      properties: {name: {type: ['string', 'null']}},
      required: ['name'],
      type: 'object',
    })
  })

  it('tolerates .optional without parens', () => {
    const result = zodToJsonSchema('z.object({ count: z.number().optional })')
    expect(result.warnings).to.deep.equal([])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      properties: {count: {type: 'number'}},
      required: [],
      type: 'object',
    })
  })

  it('converts .email() into format: email', () => {
    const result = zodToJsonSchema('z.object({ addr: z.string().email() })')
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      properties: {addr: {format: 'email', type: 'string'}},
      required: ['addr'],
      type: 'object',
    })
  })

  it('converts tuple into array with prefixItems + minItems/maxItems', () => {
    const result = zodToJsonSchema('z.tuple([z.string(), z.number()])')
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      items: false,
      maxItems: 2,
      minItems: 2,
      prefixItems: [{type: 'string'}, {type: 'number'}],
      type: 'array',
    })
  })

  it('converts zero-arg z.object() into bare object schema', () => {
    const result = zodToJsonSchema('z.object()')
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      type: 'object',
    })
  })

  it('converts variadic z.enum("a","b") as implicit array', () => {
    const result = zodToJsonSchema('z.enum("a", "b")')
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      enum: ['a', 'b'],
    })
  })
})
