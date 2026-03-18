import {expect} from 'chai'

import {ZodToTypescriptReturnValueMapper} from '../../../src/codegen/language-mappers/zod-to-typescript-return-value-mapper.js'
import {secureEvaluateSchema} from '../../../src/codegen/schema-evaluator.js'

describe('ZodToTypescriptReturnValueMapper', () => {
  describe('renderField', () => {
    const returnTypePropertyPath = ['first', 'second', 'third']

    it('Can successfully parse strings', () => {
      const zodAst = secureEvaluateSchema(`z.string()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse strings with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.string()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse numbers', () => {
      const zodAst = secureEvaluateSchema(`z.number()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse numbers with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.number()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse integer numbers', () => {
      const zodAst = secureEvaluateSchema(`z.number().int()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse integer numbers with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.number().int()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse booleans', () => {
      const zodAst = secureEvaluateSchema(`z.boolean()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse booleans with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.boolean()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse any', () => {
      const zodAst = secureEvaluateSchema(`z.any()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse any with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.any()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse an array wrapped type', () => {
      const zodAst = secureEvaluateSchema(`z.array(z.string())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse an array wrapped type with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.array(z.string())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse an array chained type', () => {
      const zodAst = secureEvaluateSchema(`z.string().array()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse an array chained type with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.string().array()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse an enum', () => {
      const zodAst = secureEvaluateSchema(`z.enum(["first", "second"])`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse an enum with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.enum(["first", "second"])`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse null', () => {
      const zodAst = secureEvaluateSchema(`z.null()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse null with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.null()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse undefined', () => {
      const zodAst = secureEvaluateSchema(`z.undefined()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse undefined with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.undefined()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse unknown', () => {
      const zodAst = secureEvaluateSchema(`z.unknown()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse unknown with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.unknown()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse unions', () => {
      const zodAst = secureEvaluateSchema(`z.union([z.string(), z.number()])`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse unions defined with or chaining with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.string().or(z.number())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse unions defined with or chaining', () => {
      const zodAst = secureEvaluateSchema(`z.string().or(z.number())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse unions defined with or chaining with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.string().or(z.number())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse tuples', () => {
      const zodAst = secureEvaluateSchema(`z.tuple([z.string(), z.number()])`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": [raw?.[0]!, raw?.[1]!]')
    })

    it('Can successfully parse tuples with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.tuple([z.string(), z.number()])`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal(
        "\"someKey\": [raw?.['first']?.['second']?.['third']?.[0]!, raw?.['first']?.['second']?.['third']?.[1]!]",
      )
    })

    it('Can successfully parse objects', () => {
      const zodAst = secureEvaluateSchema(`z.object({ name: z.string(), age: z.number() })`)
      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('"someKey": { "name": raw?.[\'name\']!, "age": raw?.[\'age\']! }')
    })

    it('Can successfully parse objects with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.object({ name: z.string(), age: z.number() })`)
      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal(
        "\"someKey\": { \"name\": raw?.['first']?.['second']?.['third']?.['name']!, \"age\": raw?.['first']?.['second']?.['third']?.['age']! }",
      )
    })

    it('Can successfully parse records', () => {
      const zodAst = secureEvaluateSchema(`z.record(z.string(), z.number())`)
      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse records with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.record(z.string(), z.number())`)
      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})
      const rendered = mapper.renderField(zodAst.schema!)
      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse an optional wrapped type', () => {
      const zodAst = secureEvaluateSchema(`z.optional(z.string())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse an optional wrapped type with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.optional(z.string())`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse an optional chained type', () => {
      const zodAst = secureEvaluateSchema(`z.string().optional()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": raw')
    })

    it('Can successfully parse an optional chained type with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.string().optional()`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal("\"someKey\": raw?.['first']?.['second']?.['third']!")
    })

    it('Can successfully parse functions', () => {
      const zodAst = secureEvaluateSchema(`z.function({input: z.tuple([z.string(), z.number()]), output: z.boolean()})`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal('"someKey": (params) => Mustache.render(raw ?? "", params)')
    })

    it('Can successfully parse functions with property paths', () => {
      const zodAst = secureEvaluateSchema(`z.function({input: z.tuple([z.string(), z.number()]), output: z.boolean()})`)

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey', returnTypePropertyPath})

      const rendered = mapper.renderField(zodAst.schema!)

      expect(rendered).to.equal(
        "\"someKey\": (params) => Mustache.render(raw?.['first']?.['second']?.['third']! ?? \"\", params)",
      )
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

      const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

      const rendered = mapper.renderField(zodAst.schema!)

      // NOTE: isActive is set to `any` because of the default value, which is not currently supported in the mapper.
      expect(rendered).to.equal(
        '"someKey": { "name": raw?.[\'name\']!, "age": raw?.[\'age\']!, "topLevel": (params) => Mustache.render(raw?.[\'topLevel\']! ?? "", params), "more": { "details": raw?.[\'more\']?.[\'details\']!, "count": raw?.[\'more\']?.[\'count\']!, "exec": (params) => Mustache.render(raw?.[\'more\']?.[\'exec\']! ?? "", params) }, "tags": raw?.[\'tags\']!, "isActive": raw?.[\'isActive\']! }',
      )
    })

    describe('meta support', () => {
      it('Can successfully parse a string with meta description', () => {
        const zodAst = secureEvaluateSchema(`z.string().meta({ description: "User's email address" })`)

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'email'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** User\'s email address */ "email": raw')
      })

      it('Can successfully parse a number with meta description', () => {
        const zodAst = secureEvaluateSchema(`z.number().meta({ description: "User's age in years" })`)

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'age'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** User\'s age in years */ "age": raw')
      })

      it('Can successfully parse objects with mixed meta and non-meta fields', () => {
        const zodAst = secureEvaluateSchema(`z.object({
          email: z.string().meta({ description: "User's email address" }),
          age: z.number().meta({ description: "User's age in years" }),
          name: z.string()
        })`)

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'user'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal(
          '"user": { /** User\'s email address */ "email": raw?.[\'email\']!, /** User\'s age in years */ "age": raw?.[\'age\']!, "name": raw?.[\'name\']! }',
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

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'data'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal(
          '"data": { "user": { "profile": { /** User biography */ "bio": raw?.[\'user\']?.[\'profile\']?.[\'bio\']! } } }',
        )
      })

      it('Can successfully parse optional fields with meta descriptions', () => {
        const zodAst = secureEvaluateSchema(`z.string().optional().meta({ description: "Optional user nickname" })`)

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'nickname'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** Optional user nickname */ "nickname": raw')
      })

      it('Can successfully parse arrays with meta descriptions', () => {
        const zodAst = secureEvaluateSchema(`z.array(z.string()).meta({ description: "List of user tags" })`)

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'tags'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal('/** List of user tags */ "tags": raw')
      })

      it('Renders JSON for meta with non-description fields', () => {
        // IMPORTANT: meta.id values MUST BE UNIQUE across the test suite because of how zod manages the schema registry
        const zodAst = secureEvaluateSchema(`z.string().meta({ id: "return-value-some-id", title: "Some Title" })`)

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'someKey'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.include('/**')
        expect(rendered).to.include('"id": "return-value-some-id"')
        expect(rendered).to.include('"title": "Some Title"')
        expect(rendered).to.include('"someKey": raw')
      })

      it('Renders JSON for meta with description and other fields', () => {
        const zodAst = secureEvaluateSchema(
          // IMPORTANT: meta.id values MUST BE UNIQUE across the test suite because of how zod manages the schema registry
          `z.string().meta({ description: "User email", id: "return-value-email-field", required: true })`,
        )

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'email'})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.include('/**')
        expect(rendered).to.include('"description": "User email"')
        expect(rendered).to.include('"id": "return-value-email-field"')
        expect(rendered).to.include('"required": true')
        expect(rendered).to.include('"email": raw')
      })

      it('Renders multi-line block comment for JSON meta', () => {
        const zodAst = secureEvaluateSchema(
          // IMPORTANT: meta.id values MUST BE UNIQUE across the test suite because of how zod manages the schema registry
          `z.string().meta({ id: "return-value-field-1", deprecated: true, replacement: "newField" })`,
        )

        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'oldField'})

        const rendered = mapper.renderField(zodAst.schema!)

        // Should contain multi-line block comment format
        expect(rendered).to.include('/**\n')
        expect(rendered).to.include(' * ')
        expect(rendered).to.match(/\*\/\s+"oldField": raw/)
      })

      it('Can successfully parse complex types with meta descriptions and property paths', () => {
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

        const returnTypePropertyPath = ['userData']
        const mapper = new ZodToTypescriptReturnValueMapper({fieldName: 'response', returnTypePropertyPath})

        const rendered = mapper.renderField(zodAst.schema!)

        expect(rendered).to.equal(
          "\"response\": { /** Unique user identifier */ \"userId\": raw?.['userData']?.['userId']!, \"settings\": { /** UI theme preference */ \"theme\": raw?.['userData']?.['settings']?.['theme']!, /** Enable notifications */ \"notifications\": raw?.['userData']?.['settings']?.['notifications']! }, \"metadata\": raw?.['userData']?.['metadata']! }",
        )
      })
    })
  })
})
