import {expect} from 'chai'

import {ZodToStringMapper} from '../../../src/codegen/language-mappers/zod-to-string-mapper.js'
import {secureEvaluateSchema} from '../../../src/codegen/schema-evaluator.js'

describe('ZodToStringMapper', () => {
  describe('renderField', () => {
    it('Can successfully parse strings', () => {
      const zodAst = secureEvaluateSchema(`z.string()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.string()')
    })

    it('Can successfully parse numbers', () => {
      const zodAst = secureEvaluateSchema(`z.number()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.number()')
    })

    it('Can successfully parse integer numbers', () => {
      const zodAst = secureEvaluateSchema(`z.number().int()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.number().int()')
    })

    it('Can successfully parse booleans', () => {
      const zodAst = secureEvaluateSchema(`z.boolean()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.boolean()')
    })

    it('Can successfully parse any', () => {
      const zodAst = secureEvaluateSchema(`z.any()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.any()')
    })

    it('Can successfully parse an array wrapped type', () => {
      const zodAst = secureEvaluateSchema(`z.array(z.string())`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.array(z.string())')
    })

    it('Can successfully parse an array chained type', () => {
      const zodAst = secureEvaluateSchema(`z.string().array()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.array(z.string())')
    })

    it('Can successfully parse an enum', () => {
      const zodAst = secureEvaluateSchema(`z.enum(["first", "second"])`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("z.enum(['first','second'])")
    })

    it('Can successfully parse null', () => {
      const zodAst = secureEvaluateSchema(`z.null()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.null()')
    })

    it('Can successfully parse undefined', () => {
      const zodAst = secureEvaluateSchema(`z.undefined()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.undefined()')
    })

    it('Can successfully parse unknown', () => {
      const zodAst = secureEvaluateSchema(`z.unknown()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.unknown()')
    })

    it('Can successfully parse unions', () => {
      const zodAst = secureEvaluateSchema(`z.union([z.string(), z.number()])`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.union([z.string(), z.number()])')
    })

    it('Can successfully parse unions defined with or chaining', () => {
      const zodAst = secureEvaluateSchema(`z.string().or(z.number())`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.union([z.string(), z.number()])')
    })

    it('Can successfully parse tuples', () => {
      const zodAst = secureEvaluateSchema(`z.tuple([z.string(), z.number()])`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.tuple([z.string(), z.number()])')
    })

    it('Can successfully parse objects', () => {
      const zodAst = secureEvaluateSchema(`z.object({ name: z.string(), age: z.number() })`)
      const mapper = new ZodToStringMapper()
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('z.object({name: z.string(); age: z.number()})')
    })

    it('Can successfully parse records', () => {
      const zodAst = secureEvaluateSchema(`z.record(z.string(), z.number())`)
      const mapper = new ZodToStringMapper()
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('z.record(z.string(), z.number())')
    })

    it('Can successfully parse records with object values', () => {
      const zodAst = secureEvaluateSchema(`z.record(z.string(), z.object({ id: z.string(), count: z.number() }))`)
      const mapper = new ZodToStringMapper()
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('z.record(z.string(), z.object({id: z.string(); count: z.number()}))')
    })

    it('Can successfully parse an optional wrapped type', () => {
      const zodAst = secureEvaluateSchema(`z.optional(z.string())`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.string().optional()')
    })

    it('Can successfully parse an optional chained type', () => {
      const zodAst = secureEvaluateSchema(`z.string().optional()`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.string().optional()')
    })

    it('Can successfully parse functions', () => {
      const zodAst = secureEvaluateSchema(`z.function({input: z.tuple([z.string(), z.number()]), output: z.boolean()})`)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('z.function({input: z.tuple([z.string(), z.number()]), output: z.boolean()})')
    })

    it('Can successfully complex combinations of types', () => {
      const zodString = `
          z.object({
            name: z.string(),
            age: z.number().int(),
            topLevel: z.function({input: z.tuple([z.boolean().optional(), z.any()]), output: z.string()}),
            more: z.object({
              details: z.string(),
              count: z.number().int(),
              exec: z.function({input: z.tuple([z.string()]), output: z.boolean().optional()}),
            }),
            tags: z.array(z.string()).optional(),
            isActive: z.boolean().default(true),
          })
        `

      const zodAst = secureEvaluateSchema(zodString)

      const mapper = new ZodToStringMapper()

      const rendered = mapper.renderField(zodAst.schema!)

      // NOTE: isActive now correctly unwraps the default to get the inner boolean type
      expect(rendered).to.equal(
        'z.object({name: z.string(); age: z.number().int(); topLevel: z.function({input: z.tuple([z.boolean().optional(), z.any()]), output: z.string()}); more: z.object({details: z.string(); count: z.number().int(); exec: z.function({input: z.tuple([z.string()]), output: z.boolean().optional()})}); tags: z.array(z.string()).optional(); isActive: z.boolean()})',
      )
    })
  })
})
