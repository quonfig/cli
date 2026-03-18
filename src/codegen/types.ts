import {z} from 'zod'
import {$ZodFunctionArgs, $ZodFunctionOut, util} from 'zod/v4/core'

export enum SupportedLanguage {
  Node = 'node-ts',
  React = 'react-ts',
}

export interface ConfigValue {
  value: {
    bool?: boolean
    int?: number
    json?: {
      json: string
    }
    logLevel?: string
    schema?: {
      schema: string
      schemaType: string
    }
    string?: string
  }
}

export interface ConfigRow {
  values: ConfigValue[]
}

export interface Config {
  configType: 'CONFIG' | 'FEATURE_FLAG' | 'SCHEMA'
  key: string
  rows: ConfigRow[]
  schemaKey?: string
  sendToClientSdk?: boolean
  valueType: 'BOOL' | 'DOUBLE' | 'DURATION' | 'INT' | 'JSON' | 'LOG_LEVEL' | 'STRING' | 'STRING_LIST'
}

export interface ConfigFile {
  configs: Config[]
}

/**
 * Supported Zod schema types for codegen
 */
export type ZodTypeSupported =
  | z.ZodAny
  | z.ZodArray<z.ZodTypeAny>
  | z.ZodBoolean
  | z.ZodDefault<z.ZodTypeAny>
  | z.ZodEnum<util.EnumLike>
  | z.ZodFunction<$ZodFunctionArgs, $ZodFunctionOut>
  | z.ZodNull
  | z.ZodNumber
  | z.ZodObject<z.ZodRawShape>
  | z.ZodOptional<z.ZodTypeAny>
  | z.ZodRecord
  | z.ZodString
  | z.ZodTuple
  | z.ZodUndefined
  | z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>
  | z.ZodUnknown
  | z.ZodNullable<z.ZodTypeAny>
  | z.ZodTypeAny
