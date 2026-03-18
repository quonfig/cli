import {z} from 'zod'

import {ZodTypeSupported} from '../types.js'
import {ZodBaseMapper} from './zod-base-mapper.js'

export class ZodToTypescriptReturnValueMapper extends ZodBaseMapper {
  private fieldName: string | undefined
  private FUNCTION_ARGUMENTS_NAME = 'params'
  private metaDescription: string | undefined = undefined
  private returnTypePropertyPath: string[]

  constructor({fieldName, returnTypePropertyPath}: {fieldName?: string; returnTypePropertyPath?: string[]} = {}) {
    super()
    this.fieldName = fieldName
    this.returnTypePropertyPath = returnTypePropertyPath ?? []
  }

  any() {
    return `raw${this.printPropertyPath()}`
  }

  array() {
    // Explicity not supporting naviagtion into array items, as the number of items is not known at compile time
    return `raw${this.printPath(this.returnTypePropertyPath)}`
  }

  boolean() {
    return `raw${this.printPropertyPath()}`
  }

  enum() {
    return `raw${this.printPropertyPath()}`
  }

  function(args: string, returns: string) {
    return `(${args}) => ${returns}`
  }

  functionArguments(value?: z.ZodTuple): string {
    if (!value) {
      return ''
    }

    // Everything is already typed, so return top level params object
    return this.FUNCTION_ARGUMENTS_NAME
  }

  // Mustache handles rendering of function values
  functionReturns(): string {
    return `Mustache.render(raw${this.printPropertyPath()} ?? "", ${this.FUNCTION_ARGUMENTS_NAME})`
  }

  null() {
    return `raw${this.printPropertyPath()}`
  }

  number() {
    return `raw${this.printPropertyPath()}`
  }

  object(properties: [string, z.ZodTypeAny][]) {
    const props = properties
      .map(([fieldName, type]) => {
        const mapper = new ZodToTypescriptReturnValueMapper({
          fieldName,
          returnTypePropertyPath: [...this.returnTypePropertyPath, fieldName],
        })
        return mapper.renderField(type)
      })
      .join(', ')

    return `{ ${props} }`
  }

  optional(wrappedType: string) {
    // In TypeScript, we hoist the optional flag  to the field definition when operating directly on a field
    if (this.fieldName) {
      return wrappedType
    }

    // Fallback to a union type w/undefined for inline optional definitions
    return this.union([wrappedType, 'undefined'])
  }

  record() {
    // Explicitly not supporting navigation into record values, as the keys are not known at compile time
    return `raw${this.printPath(this.returnTypePropertyPath)}`
  }

  renderField(type: ZodTypeSupported): string {
    if (!this.fieldName) {
      throw new Error('Field name must be set in the resolution context to render a field.')
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

    result += `"${this.fieldName}": ${resolved}`

    // Clear metaDescription to prevent it from leaking into subsequent renderField calls
    this.metaDescription = undefined

    return result
  }

  string() {
    return `raw${this.printPropertyPath()}`
  }

  tuple(wrappedTypes: string[]) {
    const tupleNavigation = wrappedTypes.map((wt, index) => {
      let massagedWrappedType = wt

      if (massagedWrappedType !== 'raw') {
        // Remove trailing ! from the wrapped type
        massagedWrappedType = massagedWrappedType.replace(/!$/, '')
      }

      return `${massagedWrappedType}?.[${index}]!`
    })

    return `[${tupleNavigation.join(`, `)}]`
  }

  undefined() {
    return `raw${this.printPropertyPath()}`
  }

  union(wrappedTypes: string[]) {
    // If we have functions in the union, force the return type to be a function type
    const functionWrappedTypes = wrappedTypes.filter((t) => t.includes('=>'))
    if (functionWrappedTypes.length > 0) {
      return functionWrappedTypes[0]
    }

    return `raw${this.printPropertyPath()}`
  }

  unknown() {
    return `raw${this.printPropertyPath()}`
  }

  protected withMeta(description: string, resolveType: () => string): string {
    // Store the description to be used when rendering the field
    this.metaDescription = description
    return resolveType()
  }

  private printPath(paths: string[]): string {
    if (paths.length === 0) {
      return ''
    }

    // Always safe navigate the path to ensure we don't throw an error if the property doesn't exist
    const path = paths.reduce((acc, part) => `${acc}?.['${part}']`, '')

    // To satisfy TypeScript's type system, tell it the value is always defined
    return `${path}!`
  }

  private printPropertyPath(): string {
    return this.printPath(this.returnTypePropertyPath)
  }
}
