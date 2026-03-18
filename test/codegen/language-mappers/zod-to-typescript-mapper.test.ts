import {expect} from 'chai'

import {ZodToTypescriptMapper} from '../../../src/codegen/language-mappers/zod-to-typescript-mapper.js'
import {secureEvaluateSchema} from '../../../src/codegen/schema-evaluator.js'

describe('ZodToTypescriptMapper', () => {
  describe('renderField', () => {
    it('Can successfully parse strings', () => {
      const zodAst = secureEvaluateSchema(`z.string()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": string')
    })

    it('Can successfully parse numbers', () => {
      const zodAst = secureEvaluateSchema(`z.number()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": number')
    })

    it('Can successfully parse integer numbers', () => {
      const zodAst = secureEvaluateSchema(`z.number().int()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": number')
    })

    it('Can successfully parse booleans', () => {
      const zodAst = secureEvaluateSchema(`z.boolean()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": boolean')
    })

    it('Can successfully parse any', () => {
      const zodAst = secureEvaluateSchema(`z.any()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": any')
    })

    it('Can successfully parse an array wrapped type', () => {
      const zodAst = secureEvaluateSchema(`z.array(z.string())`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": Array<string>')
    })

    it('Can successfully parse an array chained type', () => {
      const zodAst = secureEvaluateSchema(`z.string().array()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": Array<string>')
    })

    it('Can successfully parse an enum', () => {
      const zodAst = secureEvaluateSchema(`z.enum(["first", "second"])`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": 'first' | 'second'")
    })

    it('Can successfully parse null', () => {
      const zodAst = secureEvaluateSchema(`z.null()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": null')
    })

    it('Can successfully parse undefined', () => {
      const zodAst = secureEvaluateSchema(`z.undefined()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": undefined')
    })

    it('Can successfully parse unknown', () => {
      const zodAst = secureEvaluateSchema(`z.unknown()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": unknown')
    })

    it('Can successfully parse unions', () => {
      const zodAst = secureEvaluateSchema(`z.union([z.string(), z.number()])`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": string | number')
    })

    it('Can successfully parse unions defined with or chaining', () => {
      const zodAst = secureEvaluateSchema(`z.string().or(z.number())`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": string | number')
    })

    it('Can successfully parse tuples', () => {
      const zodAst = secureEvaluateSchema(`z.tuple([z.string(), z.number()])`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": [string, number]')
    })

    it('Can successfully parse objects', () => {
      const zodAst = secureEvaluateSchema(`z.object({ name: z.string(), age: z.number() })`)
      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('"someKey": { "name": string; "age": number }')
    })

    it('Can successfully parse records', () => {
      const zodAst = secureEvaluateSchema(`z.record(z.string(), z.number())`)
      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('"someKey": Record<string, number>')
    })

    it('Can successfully parse records with object values', () => {
      const zodAst = secureEvaluateSchema(`z.record(z.string(), z.object({ id: z.string(), count: z.number() }))`)
      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('"someKey": Record<string, { "id": string; "count": number }>')
    })

    it('Can successfully parse an optional wrapped type', () => {
      const zodAst = secureEvaluateSchema(`z.optional(z.string())`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey"?: string')
    })

    it('Can successfully parse an optional chained type', () => {
      const zodAst = secureEvaluateSchema(`z.string().optional()`)

      const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey"?: string')
    })

    describe('when the target = "accessor"', () => {
      it('Can successfully parse functions', () => {
        const zodAst = secureEvaluateSchema(
          `z.function({input: z.tuple([z.string(), z.number()]), output: z.boolean()})`,
        )

        const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('"someKey": (...params: [string, number]) => boolean')
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

        const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

        const rendered = mapper.renderField(zodAst.schema!)

        // NOTE: isActive now correctly unwraps the default to get the inner boolean type
        expect(rendered).to.equal(
          '"someKey": { "name": string; "age": number; "topLevel": (...params: [boolean | undefined, any]) => string; "more": { "details": string; "count": number; "exec": (...params: [string]) => boolean | undefined }; "tags"?: Array<string>; "isActive": boolean }',
        )
      })
    })

    describe('when the target = "raw"', () => {
      it('Can successfully parse functions', () => {
        const zodAst = secureEvaluateSchema(
          `z.function({input: z.tuple([z.string(), z.number()]), output: z.boolean()})`,
        )

        const mapper = new ZodToTypescriptMapper({fieldName: 'someKey', target: 'raw'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('"someKey": string | undefined')
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

        const mapper = new ZodToTypescriptMapper({fieldName: 'someKey', target: 'raw'})

        const rendered = mapper.renderField(zodAst.schema!)

        // NOTE: isActive now correctly unwraps the default to get the inner boolean type
        expect(rendered).to.equal(
          '"someKey": { "name": string; "age": number; "topLevel": string | undefined; "more": { "details": string; "count": number; "exec": string | undefined }; "tags"?: Array<string>; "isActive": boolean }',
        )
      })
    })

    describe('meta support', () => {
      it('Can successfully parse a string with meta description', () => {
        const zodAst = secureEvaluateSchema(`z.string().meta({ description: "User's email address" })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'email'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** User\'s email address */ "email": string')
      })

      it('Can successfully parse a number with meta description', () => {
        const zodAst = secureEvaluateSchema(`z.number().meta({ description: "User's age in years" })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'age'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** User\'s age in years */ "age": number')
      })

      it('Can successfully parse objects with mixed meta and non-meta fields', () => {
        const zodAst = secureEvaluateSchema(`z.object({
          email: z.string().meta({ description: "User's email address" }),
          age: z.number().meta({ description: "User's age in years" }),
          name: z.string()
        })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'user'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal(
          '"user": { /** User\'s email address */ "email": string; /** User\'s age in years */ "age": number; "name": string }',
        )
      })

      it('Can successfully parse nested objects with meta descriptions', () => {
        const zodAst = secureEvaluateSchema(`z.object({
          user: z.object({
            profile: z.object({
              bio: z.string().meta({ description: "User biography" })
            })
          })
        })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'data'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('"data": { "user": { "profile": { /** User biography */ "bio": string } } }')
      })

      it('Can successfully parse optional fields with meta descriptions', () => {
        const zodAst = secureEvaluateSchema(`z.string().optional().meta({ description: "Optional user nickname" })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'nickname'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** Optional user nickname */ "nickname"?: string')
      })

      it('Can successfully parse arrays with meta descriptions', () => {
        const zodAst = secureEvaluateSchema(`z.array(z.string()).meta({ description: "List of user tags" })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'tags'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** List of user tags */ "tags": Array<string>')
      })

      it('Renders JSON for meta with non-description fields', () => {
        // IMPORTANT: meta.id values MUST BE UNIQUE across the test suite because of how zod manages the schema registry
        const zodAst = secureEvaluateSchema(`z.string().meta({ id: "some-id", title: "Some Title" })`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'someKey'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.include('/**')
        expect(rendered).to.include('"id": "some-id"')
        expect(rendered).to.include('"title": "Some Title"')
        expect(rendered).to.include('"someKey": string')
      })

      it('Renders JSON for meta with description and other fields', () => {
        const zodAst = secureEvaluateSchema(
          // IMPORTANT: meta.id values MUST BE UNIQUE across the test suite because of how zod manages the schema registry
          `z.string().meta({ description: "User email", id: "email-field", required: true })`,
        )

        const mapper = new ZodToTypescriptMapper({fieldName: 'email'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.include('/**')
        expect(rendered).to.include('"description": "User email"')
        expect(rendered).to.include('"id": "email-field"')
        expect(rendered).to.include('"required": true')
        expect(rendered).to.include('"email": string')
      })

      it('Renders multi-line block comment for JSON meta', () => {
        const zodAst = secureEvaluateSchema(
          // IMPORTANT: meta.id values MUST BE UNIQUE across the test suite because of how zod manages the schema registry
          `z.string().meta({ id: "field-1", deprecated: true, replacement: "newField" })`,
        )

        const mapper = new ZodToTypescriptMapper({fieldName: 'oldField'})

        const rendered = mapper.renderField(zodAst.schema!)

        // Should contain multi-line block comment format
        expect(rendered).to.include('/**\n')
        expect(rendered).to.include(' * ')
        expect(rendered).to.match(/\*\/\s+"oldField": string/)
      })

      it('Can successfully parse complex types with meta descriptions', () => {
        const zodString = `
          z.object({
            userId: z.string().meta({ description: "Unique user identifier" }),
            settings: z.object({
              theme: z.enum(["light", "dark"]).meta({ description: "UI theme preference" }),
              notifications: z.boolean().meta({ description: "Enable notifications" })
            }),
            metadata: z.record(z.string(), z.any()).optional()
          })
        `

        const zodAst = secureEvaluateSchema(zodString)

        const mapper = new ZodToTypescriptMapper({fieldName: 'userData'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal(
          '"userData": { /** Unique user identifier */ "userId": string; "settings": { /** UI theme preference */ "theme": \'light\' | \'dark\'; /** Enable notifications */ "notifications": boolean }; "metadata"?: Record<string, any> }',
        )
      })
    })

    describe('ignores describe', () => {
      it('Can successfully parse a string with describe (value is ignored)', () => {
        const zodAst = secureEvaluateSchema(`z.string().describe("User's email address")`)

        const mapper = new ZodToTypescriptMapper({fieldName: 'email'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('"email": string')
      })

      it('Can successfully parse a string with meta + describe (value is ignored)', () => {
        const zodAst = secureEvaluateSchema(
          `z.string().meta({description: "Meta description"}).describe("Description description")`,
        )

        const mapper = new ZodToTypescriptMapper({fieldName: 'email'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** Meta description */ "email": string')
      })
    })
  })
})
