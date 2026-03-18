import {expect} from 'chai'
import {z} from 'zod'

import {JsonToZodMapper} from '../../../src/codegen/language-mappers/json-to-zod-mapper.js'
import * as introspect from '../../../src/codegen/zod-introspection.js'

describe('JsonToZodMapper', () => {
  const mapper = new JsonToZodMapper()

  describe('resolve', () => {
    it('should resolve homogeneous array of numbers', () => {
      const input = [1, 2, 3]

      const result = mapper.resolve(input)

      expect(introspect.isArray(result)).to.be.true
      const element = introspect.getArrayElement(result as z.ZodArray<z.ZodTypeAny>)
      expect(introspect.isNumber(element)).to.be.true
    })

    it('should resolve homogeneous array of strings', () => {
      const input = ['a', 'b', 'c']

      const result = mapper.resolve(input)

      expect(introspect.isArray(result)).to.be.true
      const element = introspect.getArrayElement(result as z.ZodArray<z.ZodTypeAny>)
      expect(introspect.isString(element)).to.be.true
    })

    it('should resolve homogeneous array of booleans', () => {
      const input = [true, false, true]

      const result = mapper.resolve(input)

      expect(introspect.isArray(result)).to.be.true
      const element = introspect.getArrayElement(result as z.ZodArray<z.ZodTypeAny>)
      expect(introspect.isBoolean(element)).to.be.true
    })

    it('should resolve heterogeneous array to unknown', () => {
      const input = [1, 'a', true]

      const result = mapper.resolve(input)

      expect(introspect.isArray(result)).to.be.true
      const element = introspect.getArrayElement(result as z.ZodArray<z.ZodTypeAny>)
      expect(introspect.isUnknown(element)).to.be.true
    })

    it('should resolve object with primitive types', () => {
      const input = {age: 30, isActive: true, name: 'Alice'}

      const result = mapper.resolve(input)

      expect(introspect.isObject(result)).to.be.true
      const shape = introspect.getObjectShape(result as z.ZodObject<z.ZodRawShape>)
      expect(Object.keys(shape).sort()).to.deep.equal(['age', 'isActive', 'name'])
      expect(introspect.isNumber(shape.age)).to.be.true
      expect(introspect.isBoolean(shape.isActive)).to.be.true
      expect(introspect.isString(shape.name)).to.be.true
    })

    it('should resolve deeply nested objects', () => {
      const input = {isActive: true, user: {age: 30, name: 'Alice'}}

      const result = mapper.resolve(input)

      expect(introspect.isObject(result)).to.be.true
      const shape = introspect.getObjectShape(result as z.ZodObject<z.ZodRawShape>)
      expect(Object.keys(shape).sort()).to.deep.equal(['isActive', 'user'])
      expect(introspect.isBoolean(shape.isActive)).to.be.true
      expect(introspect.isObject(shape.user)).to.be.true
      const userShape = introspect.getObjectShape(shape.user as z.ZodObject<z.ZodRawShape>)
      expect(Object.keys(userShape).sort()).to.deep.equal(['age', 'name'])
      expect(introspect.isNumber(userShape.age)).to.be.true
      expect(introspect.isString(userShape.name)).to.be.true
    })

    it('should resolve array of objects', () => {
      const input = [{name: 'Alice'}, {name: 'Bob'}]

      const result = mapper.resolve(input)

      expect(introspect.isArray(result)).to.be.true
      const element = introspect.getArrayElement(result as z.ZodArray<z.ZodTypeAny>)
      expect(introspect.isObject(element)).to.be.true
      const shape = introspect.getObjectShape(element as z.ZodObject<z.ZodRawShape>)
      expect(Object.keys(shape)).to.deep.equal(['name'])
      expect(introspect.isString(shape.name)).to.be.true
    })

    it('should resolve null values', () => {
      const input = null

      const result = mapper.resolve(input)

      expect(introspect.isNull(result)).to.be.true
    })
  })
})
