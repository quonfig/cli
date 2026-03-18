import {z} from 'zod'
import {$ZodTupleDef, $ZodFunctionArgs, $ZodFunctionOut, $ZodType, util} from 'zod/v4/core'

import {ZodBaseMapper} from './zod-base-mapper.js'

export class ZodToStringMapper extends ZodBaseMapper {
  any() {
    return 'z.any()'
  }

  array(wrappedType: string) {
    return `z.array(${wrappedType})`
  }

  boolean() {
    return 'z.boolean()'
  }

  enum(values: util.EnumValue[]) {
    return `z.enum([${values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(',')}])`
  }

  function(input: string, output: string) {
    return `z.function({input: z.tuple([${input}]), output: ${output}})`
  }

  functionArguments(value?: $ZodFunctionArgs): string {
    if (!value) {
      return ''
    }

    const def = (value as z.ZodTypeAny).def as $ZodTupleDef
    const items = def.items || []
    const args = items.map((item: $ZodType) => {
      const mapper = new ZodToStringMapper()
      return mapper.resolveType(item)
    })

    return args.join(', ')
  }

  functionReturns(value: $ZodFunctionOut): string {
    const mapper = new ZodToStringMapper()
    return mapper.resolveType(value)
  }

  null() {
    return 'z.null()'
  }

  number(isInteger: boolean = false) {
    const base = 'z.number()'

    if (isInteger) {
      return `${base}.int()`
    }

    return base
  }

  object(properties: [string, z.ZodTypeAny][]) {
    const props = properties
      .map(([key, type]) => {
        const mapper = new ZodToStringMapper()
        return mapper.renderField(type, key)
      })
      .join('; ')

    return `z.object({${props}})`
  }

  optional(wrappedType: string) {
    return `${wrappedType}.optional()`
  }

  record(keyType: string, valueType: string) {
    return `z.record(${keyType}, ${valueType})`
  }

  renderField(type: z.ZodTypeAny, key?: string): string {
    const resolved = this.resolveType(type)

    if (key) {
      return `${key}: ${resolved}`
    }

    return resolved
  }

  string() {
    return 'z.string()'
  }

  tuple(wrappedTypes: string[]) {
    return `z.tuple([${wrappedTypes.join(', ')}])`
  }

  undefined() {
    return 'z.undefined()'
  }

  union(wrappedTypes: string[]) {
    return `z.union([${wrappedTypes.join(', ')}])`
  }

  unknown() {
    return 'z.unknown()'
  }
}
