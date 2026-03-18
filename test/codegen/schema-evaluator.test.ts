import {expect} from 'chai'
import {z} from 'zod'

import {secureEvaluateSchema} from '../../src/codegen/schema-evaluator.js'
import * as introspect from '../../src/codegen/zod-introspection.js'

describe('SchemaEvaluator', () => {
  describe('secureEvaluateSchema', () => {
    it('should properly evaluate valid schema strings', () => {
      const result = secureEvaluateSchema('z.object({ name: z.string(), age: z.number() })')

      expect(result.success).to.be.true
      expect(result.schema).to.exist

      if (result.schema) {
        expect(introspect.isObject(result.schema)).to.be.true
        const shape = introspect.getObjectShape(result.schema as z.ZodObject<z.ZodRawShape>)
        expect(introspect.isString(shape.name)).to.be.true
        expect(introspect.isNumber(shape.age)).to.be.true
      }
    })

    it('should handle complex schema strings', () => {
      const schemaStr = `
        z.object({
          id: z.string().uuid(),
          name: z.string().min(3).max(50),
          email: z.string().email(),
          age: z.number().int().positive().optional(),
          tags: z.array(z.string()),
          metadata: z.record(z.string(), z.any())
        })
      `

      const result = secureEvaluateSchema(schemaStr)

      expect(result.success).to.be.true
      expect(result.schema).to.exist
    })

    it('should reject schema strings with syntax errors', () => {
      const result = secureEvaluateSchema('z.object({ name: z.string(, })')

      expect(result.success).to.be.false
      expect(result.error).to.include('Evaluation error')
    })

    it('should reject schema strings with unsupported operations', () => {
      // Trying to use a forbidden global object
      const result = secureEvaluateSchema('z.object({ test: z.string() }).refine(() => console.log("hello"))')

      expect(result.success).to.be.false
      expect(result.error).to.include('potentially unsafe operations')
      expect(result.error).to.include('console')
    })

    it('should reject schema strings attempting to use unsupported properties', () => {
      // Trying to access constructor
      const result = secureEvaluateSchema('z.object({ test: z.string() }).constructor')

      expect(result.success).to.be.false
      expect(result.error).to.include('potentially unsafe operations')
      expect(result.error).to.include('constructor')
    })

    it('should allow valid refinements with arrow functions', () => {
      // Valid refinement
      const result = secureEvaluateSchema(
        'z.string().refine((val) => val.length > 5, { message: "Must be more than 5 characters" })',
      )

      expect(result.success).to.be.true
      expect(result.schema).to.exist

      if (result.schema) {
        expect(result.schema).to.be.instanceOf(z.ZodType)
      }
    })

    it('should reject schema strings exceeding maximum complexity', () => {
      // Generate a very complex schema by creating a deep nesting
      let complexSchema = 'z.object({'
      for (let i = 0; i < 100; i++) {
        complexSchema += `prop${i}: z.object({nested: z.string()}),`
      }

      complexSchema += '})'

      const result = secureEvaluateSchema(complexSchema, {maxAstNodes: 200})

      expect(result.success).to.be.false
      expect(result.error).to.include('exceeds maximum allowed complexity')
    })

    it('should handle enum types properly', () => {
      const result = secureEvaluateSchema('z.enum(["pending", "active", "completed"])')

      expect(result.success).to.be.true
      expect(result.schema).to.exist

      if (result.schema) {
        expect(introspect.isEnum(result.schema)).to.be.true
        const values = introspect.getEnumValues(result.schema as z.ZodEnum<any>)
        expect(values).to.deep.equal(['pending', 'active', 'completed'])
      }
    })

    it('should handle union types', () => {
      const result = secureEvaluateSchema('z.union([z.string(), z.number(), z.boolean()])')

      expect(result.success).to.be.true
      expect(result.schema).to.exist

      if (result.schema) {
        expect(introspect.isUnion(result.schema)).to.be.true
        const options = introspect.getUnionOptions(result.schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>)
        expect(options).to.have.length(3)
        expect(introspect.isString(options[0])).to.be.true
        expect(introspect.isNumber(options[1])).to.be.true
        expect(introspect.isBoolean(options[2])).to.be.true
      }
    })

    it('should strip .describe() calls from schema', () => {
      const result = secureEvaluateSchema('z.string().describe("A string field")')

      expect(result.success).to.be.true
      expect(result.schema).to.exist

      // Verify the schema is a plain string schema without description
      if (result.schema) {
        expect(introspect.isString(result.schema)).to.be.true
      }
    })

    it('should strip .describe() and keep .meta()', () => {
      const result = secureEvaluateSchema('z.string().describe("desc").meta({ description: "A string field" })')

      expect(result.success).to.be.true
      expect(result.schema).to.exist

      // Verify meta is still accessible
      if (result.schema) {
        expect(introspect.isString(result.schema)).to.be.true
        const meta = introspect.getMeta(result.schema)
        expect(meta).to.exist
        expect(meta?.description).to.equal('A string field')
      }
    })

    it('should allow .meta() with description', () => {
      const result = secureEvaluateSchema('z.string().meta({ description: "A string field" })')

      expect(result.success).to.be.true
      expect(result.schema).to.exist
    })
  })
})
