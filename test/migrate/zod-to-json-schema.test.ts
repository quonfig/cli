import {expect} from 'chai'

import {zodToJsonSchema} from '../../src/migrate/sources/launch/zod-to-json-schema.js'

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

describe('zodToJsonSchema (inline)', () => {
  it('converts a simple object with required string', () => {
    const result = zodToJsonSchema('z.object({ name: z.string() })')
    expect(result.warnings).to.deep.equal([])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      additionalProperties: false,
      properties: {name: {type: 'string'}},
      required: ['name'],
      type: 'object',
    })
  })

  it('handles meta({description}) and records ignored meta fields', () => {
    const result = zodToJsonSchema('z.object({\n  count: z.number().meta({ description: "Count", custom: 1 })\n})')
    expect(result.warnings).to.deep.equal(['Ignored unsupported meta field "custom"'])
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      additionalProperties: false,
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
      additionalProperties: false,
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
      additionalProperties: false,
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
      additionalProperties: false,
      properties: {count: {type: 'number'}},
      required: [],
      type: 'object',
    })
  })

  it('converts .email() into format: email', () => {
    const result = zodToJsonSchema('z.object({ addr: z.string().email() })')
    expect(result.schema).to.deep.equal({
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      additionalProperties: false,
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

  // qfg-mrab: Quonfig's UI-side schema validator requires additionalProperties:false
  // on every object that declares properties. Default zod is open, so the converter
  // emits additionalProperties:false unconditionally. .strict() stays accepted but
  // is now a no-op (idempotent).
  it('emits additionalProperties:false on default z.object()', () => {
    const result = zodToJsonSchema('z.object({ name: z.string() })')
    expect((result.schema as Record<string, unknown>).additionalProperties).to.equal(false)
  })

  it('keeps .strict() as a no-op (still produces additionalProperties:false)', () => {
    const result = zodToJsonSchema('z.object({ name: z.string() }).strict()')
    expect((result.schema as Record<string, unknown>).additionalProperties).to.equal(false)
  })

  it('emits additionalProperties:false on record value object schemas', () => {
    const result = zodToJsonSchema('z.record(z.object({ a: z.string() }))')
    const schema = result.schema as Record<string, unknown>
    expect(schema.type).to.equal('object')
    const valueSchema = schema.additionalProperties as Record<string, unknown>
    expect(valueSchema.type).to.equal('object')
    expect(valueSchema.additionalProperties).to.equal(false)
  })
})
