import {z} from 'zod'
import {$ZodFunctionArgs, $ZodFunctionOut, $ZodType, util} from 'zod/v4/core'

import * as introspect from '../zod-introspection.js'

export abstract class ZodBaseMapper {
  resolveType(type: $ZodType): string {
    // Check for meta description first and allow implementers to handle it
    const metaDescription = introspect.getMetaDescription(type)
    if (metaDescription) {
      const result = this.withMeta(metaDescription, () => this.resolveTypeInternal(type))
      return result
    }

    return this.resolveTypeInternal(type)
  }

  /**
   * Hook for handling meta descriptions on schemas.
   * By default, this just returns the resolved type without any modification.
   * Subclasses can override this to add comments or other metadata handling.
   *
   * @param description The description from .meta({ description: "..." })
   * @param resolveType A function that resolves the inner type
   * @returns The type string, potentially with description metadata
   */
  protected withMeta(description: string, resolveType: () => string): string {
    // Default implementation: just return the resolved type
    return resolveType()
  }

  private resolveTypeInternal(type: $ZodType): string {
    if (introspect.isAny(type)) {
      return this.any()
    }

    if (introspect.isArray(type)) {
      const element = introspect.getArrayElement(type)
      const internalType = this.resolveType(element)
      return this.array(internalType)
    }

    if (introspect.isBoolean(type)) {
      return this.boolean()
    }

    if (introspect.isDefault(type)) {
      // Unwrap default to get the inner type
      const {innerType} = introspect.unwrapDefault(type)
      const internalType = this.resolveType(innerType)
      return internalType
    }

    if (introspect.isEnum(type)) {
      const values = introspect.getEnumValues(type)
      return this.enum(values)
    }

    if (introspect.isFunction(type)) {
      const {args, returns} = introspect.getFunctionSignature(type)
      const argsStr = this.functionArguments(args)
      const returnsStr = this.functionReturns(returns)
      return this.function(argsStr, returnsStr)
    }

    if (introspect.isNull(type)) {
      return this.null()
    }

    if (introspect.isNullable(type)) {
      // Handle nullable by unwrapping it
      const innerType = introspect.unwrapNullable(type)
      return this.union([this.resolveType(innerType), this.null()])
    }

    if (introspect.isNumber(type)) {
      const isInteger = introspect.isNumberInteger(type)
      return this.number(isInteger)
    }

    if (introspect.isObject(type)) {
      const shape = introspect.getObjectShape(type)
      const props = Object.entries(shape) as [string, z.ZodTypeAny][]
      return this.object(props)
    }

    if (introspect.isOptional(type)) {
      const innerType = introspect.unwrapOptional(type)
      const internalType = this.resolveType(innerType)
      return this.optional(internalType)
    }

    if (introspect.isRecord(type)) {
      const {keyType, valueType} = introspect.getRecordTypes(type)
      const keyTypeStr = this.resolveType(keyType)
      const valueTypeStr = this.resolveType(valueType)
      return this.record(keyTypeStr, valueTypeStr)
    }

    if (introspect.isString(type)) {
      return this.string()
    }

    if (introspect.isTuple(type)) {
      const items = introspect.getTupleItems(type)
      const itemsStr = items.map((item) => this.resolveType(item))
      return this.tuple(itemsStr)
    }

    if (introspect.isUndefined(type)) {
      return this.undefined()
    }

    if (introspect.isUnion(type)) {
      const options = introspect.getUnionOptions(type)
      const optionsStr = options.map((option) => this.resolveType(option))
      return this.union(optionsStr)
    }

    if (introspect.isUnknown(type)) {
      return this.unknown()
    }

    console.warn(`Unknown zod type:`, type)
    // If the type is not recognized, default to 'any'
    return this.any()
  }

  protected abstract any(): string
  protected abstract array(wrappedType: string): string
  protected abstract boolean(): string
  protected abstract enum(values: util.EnumValue[]): string
  protected abstract function(args: string, returns: string): string
  protected abstract functionArguments(value?: $ZodFunctionArgs): string
  protected abstract functionReturns(value: $ZodFunctionOut): string
  protected abstract null(): string
  protected abstract number(isInteger: boolean): string
  protected abstract object(properties: [string, z.ZodTypeAny][]): string
  protected abstract optional(wrappedType: string): string
  protected abstract record(keyType: string, valueType: string): string
  protected abstract string(): string
  protected abstract tuple(wrappedTypes: string[]): string
  protected abstract undefined(): string
  protected abstract union(wrappedTypes: string[]): string
  protected abstract unknown(): string
}
