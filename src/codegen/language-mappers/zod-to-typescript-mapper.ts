import {z} from 'zod'

import {ZodTypeSupported} from '../types.js'
import {ZodBaseMapper} from './zod-base-mapper.js'

export type ZodToTypescriptMapperTarget = 'accessor' | 'raw'

export class ZodToTypescriptMapper extends ZodBaseMapper {
  private fieldName: string | undefined
  private metaDescription: string | undefined = undefined
  private optionalProperty: boolean
  private target: ZodToTypescriptMapperTarget

  constructor({fieldName, target}: {fieldName?: string; target?: ZodToTypescriptMapperTarget} = {}) {
    super()
    this.fieldName = fieldName
    this.optionalProperty = false
    this.target = target ?? 'accessor'
  }

  any() {
    return 'any'
  }

  array(wrappedType: string) {
    return `Array<${wrappedType}>`
  }

  boolean() {
    return 'boolean'
  }

  enum(values: string[]) {
    return values.map((v) => `'${v}'`).join(' | ')
  }

  function(args: string, returns: string) {
    // When in raw mode, we return a string type for functions,
    // as this is what comes back from the server directly
    if (this.target === 'raw') {
      return 'string | undefined'
    }

    return `(...params: ${args}) => ${returns}`
  }

  functionArguments(value?: z.ZodTuple): string {
    if (!value) {
      return ''
    }

    const mapper = new ZodToTypescriptMapper()
    return mapper.resolveType(value)
  }

  functionReturns(value: z.ZodTypeAny): string {
    const mapper = new ZodToTypescriptMapper()
    return mapper.resolveType(value)
  }

  null() {
    return 'null'
  }

  number() {
    return 'number'
  }

  object(properties: [string, z.ZodTypeAny][]) {
    const props = properties
      .map(([fieldName, type]) => {
        const mapper = new ZodToTypescriptMapper({fieldName, target: this.target})
        return mapper.renderField(type)
      })
      .join('; ')

    return `{ ${props} }`
  }

  optional(wrappedType: string) {
    // In TypeScript, we hoist the optional flag  to the field definition when operating directly on a field
    if (this.fieldName) {
      this.optionalProperty = true
      return wrappedType
    }

    // Fallback to a union type w/undefined for inline optional definitions
    return this.union([wrappedType, 'undefined'])
  }

  record(keyType: string, valueType: string) {
    return `Record<${keyType}, ${valueType}>`
  }

  renderField(type: ZodTypeSupported): string {
    if (!this.fieldName) {
      throw new Error('Field name must be set to render a field.')
    }

    // Must invoke resolveType to ensure the type is fully resolved,
    // which always guarantees that the optional flag is set correctly.
    const resolved = this.resolveType(type)

    // If there's a meta description, add it as a comment before the field
    let result = ''
    if (this.metaDescription) {
      // Check if the description contains newlines (multi-line JSON)
      if (this.metaDescription.includes('\n')) {
        // Format as a multi-line block comment
        const lines = this.metaDescription.split('\n')
        result += '/**\n'
        for (const line of lines) {
          result += ` * ${line}\n`
        }
        result += ' */ '
      } else {
        // Single line comment
        result += `/** ${this.metaDescription} */ `
      }
    }

    result += `"${this.fieldName}"${this.optionalProperty ? '?' : ''}: ${resolved}`

    return result
  }

  string() {
    return 'string'
  }

  tuple(wrappedTypes: string[]) {
    return `[${wrappedTypes.join(', ')}]`
  }

  undefined() {
    return 'undefined'
  }

  union(wrappedTypes: string[]) {
    return wrappedTypes
      .map((t) => {
        // If the type includes an arrow function, we need to wrap it in parentheses
        if (t.includes('=>')) {
          return `(${t})`
        }

        return t
      })
      .join(' | ')
  }

  unknown() {
    return 'unknown'
  }

  protected withMeta(description: string, resolveType: () => string): string {
    // Store the description to be used when rendering the field
    this.metaDescription = description
    return resolveType()
  }
}
