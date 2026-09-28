import {expect} from 'chai'
import {z} from 'zod'

import {jsonSchemaToZod} from '../../src/codegen/json-schema-to-zod.js'
import {ZodToStringMapper} from '../../src/codegen/language-mappers/zod-to-string-mapper.js'
import {ZodToTypescriptMapper} from '../../src/codegen/language-mappers/zod-to-typescript-mapper.js'
import * as introspect from '../../src/codegen/zod-introspection.js'
import {jevQuestionsSchema} from './fixtures/jev-questions-schema.js'

const toTs = (schema: z.ZodTypeAny) => new ZodToTypescriptMapper().resolveType(schema)

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
      "z.object({mode:z.enum(['warn','error']);scope:z.literal(\"workspace\")})",
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

  describe('oneOf / anyOf', () => {
    const noul = {
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {type: {const: 'noul'}, instructions: {type: 'string'}},
    }
    const score = {
      type: 'object',
      required: ['type', 'criteria'],
      additionalProperties: false,
      properties: {type: {enum: ['score']}, criteria: {type: 'array', items: {type: 'string'}}},
    }

    it('emits a union for a oneOf that also declares type: object', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        oneOf: [
          {type: 'object', properties: {a: {type: 'string'}}, required: ['a']},
          {type: 'object', properties: {b: {type: 'number'}}, required: ['b']},
        ],
      })

      expect(introspect.isUnion(schema)).to.equal(true)
      expect(toTs(schema)).to.equal('{ "a": string } | { "b": number }')
    })

    it('emits a union for a oneOf with no type', () => {
      const schema = jsonSchemaToZod({oneOf: [{type: 'string'}, {type: 'number'}]})

      expect(toTs(schema)).to.equal('string | number')
    })

    it('emits a discriminatedUnion for a tagged oneOf', () => {
      const schema = jsonSchemaToZod({type: 'object', oneOf: [noul, score]})

      expect(schema).to.be.instanceOf(z.ZodDiscriminatedUnion)
      expect((schema as z.ZodDiscriminatedUnion).def.discriminator).to.equal('type')
      expect(toTs(schema)).to.equal(
        '{ "type": "noul"; "instructions"?: string } | { "type": \'score\'; "criteria": Array<string> }',
      )
      expect(schema.safeParse({type: 'score', criteria: ['a']}).success).to.equal(true)
      expect(schema.safeParse({type: 'nope'}).success).to.equal(false)
    })

    it('falls back to a plain union when the tag values are not distinct', () => {
      const schema = jsonSchemaToZod({
        oneOf: [noul, {...noul, properties: {...noul.properties, extra: {type: 'string'}}}],
      })

      expect(schema).to.not.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(introspect.isUnion(schema)).to.equal(true)
    })

    it('falls back to a plain union when a branch is not an object', () => {
      const schema = jsonSchemaToZod({oneOf: [noul, {type: 'string'}]})

      expect(schema).to.not.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(toTs(schema)).to.equal('{ "type": "noul"; "instructions"?: string } | string')
    })

    it('falls back to a plain union when more than one property could be the tag', () => {
      const a = {type: 'object', required: ['kind', 'v'], properties: {kind: {const: 'a'}, v: {const: 1}}}
      const b = {type: 'object', required: ['kind', 'v'], properties: {kind: {const: 'b'}, v: {const: 2}}}
      const schema = jsonSchemaToZod({oneOf: [a, b]})

      expect(schema).to.not.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(introspect.isUnion(schema)).to.equal(true)
    })

    it('emits T | null for a migrated nullable anyOf', () => {
      const schema = jsonSchemaToZod({anyOf: [{type: 'string'}, {type: 'null'}]})

      expect(toTs(schema)).to.equal('string | null')
    })

    it('keeps sibling properties next to a oneOf as an intersection', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        required: ['id'],
        properties: {id: {type: 'string'}},
        oneOf: [
          {type: 'object', properties: {a: {type: 'string'}}},
          {type: 'object', properties: {b: {type: 'number'}}},
        ],
      })

      expect(toTs(schema)).to.equal('{ "id": string } & ({ "a"?: string } | { "b"?: number })')
      expect(schema.safeParse({id: 'x', a: 'y'}).success).to.equal(true)
      expect(schema.safeParse({a: 'y'}).success).to.equal(false)
    })
  })

  describe('arrays with minItems', () => {
    it('emits a tuple with a rest element for minItems without maxItems', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 2, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('[string, string, ...string[]]')
      expect(schema.safeParse(['a', 'b', 'c']).success).to.equal(true)
      expect(schema.safeParse(['a']).success).to.equal(false)
    })

    it('keeps a plain array when maxItems is also set', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 2, maxItems: 4, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('Array<string>')
    })

    it('keeps a plain array for minItems: 0', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 0, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('Array<string>')
    })
  })

  describe('the Jev questions schema', () => {
    it('emits a record of a tagged union whose score rubric has a rest element', () => {
      const schema = jsonSchemaToZod(jevQuestionsSchema)
      const questions = (schema as z.ZodObject).shape.questions as z.ZodTypeAny

      expect(introspect.isRecord(questions)).to.equal(true)
      const {valueType} = introspect.getRecordTypes(questions as z.ZodRecord)
      expect(valueType).to.be.instanceOf(z.ZodDiscriminatedUnion)

      const rendered = toTs(schema)
      expect(rendered).to.contain('"type": "noul"')
      expect(rendered).to.contain('"type": "score"')
      expect(rendered).to.contain('"type": "choice"')
      expect(rendered).to.contain('"criteria": [string, string, ...string[]] }')
      expect(rendered).to.contain('"criteria": Record<string, string> }')
      expect(rendered).to.match(
        /"criteria"\?: { (\/\*\* [^*]+ \*\/ )?"true"\?: string; (\/\*\* [^*]+ \*\/ )?"false"\?: string }/,
      )
    })
  })
})
