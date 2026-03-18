import {z} from 'zod'

import {JsonToZodMapper} from './language-mappers/json-to-zod-mapper.js'
import {ZodToStringMapper} from './language-mappers/zod-to-string-mapper.js'
import {MustacheExtractor} from './mustache-extractor.js'
import {secureEvaluateSchema} from './schema-evaluator.js'
import {type Config, type ConfigFile} from './types.js'

export type DurationTypeMap = () => z.ZodTypeAny

export class SchemaExtractor {
  constructor(private log: (category: string | unknown, message?: unknown) => void) {}

  execute({
    config,
    configFile,
    durationTypeMap,
  }: {
    config: Config
    configFile: ConfigFile
    durationTypeMap?: DurationTypeMap
  }) {
    const userDefinedSchema = this.resolveUserSchema(config, configFile)

    const schemaWithoutMustache = userDefinedSchema ?? this.inferFromConfig(config, durationTypeMap)

    return this.replaceStringsWithMustache(schemaWithoutMustache, config)
  }

  private createZodFunctionFromMustacheStrings(strings: string[]): z.ZodTypeAny {
    if (strings.length === 0) {
      return z.string()
    }

    if (strings.length > 1) {
      // De-dup exact schemas
      const schemas: Record<string, z.ZodTypeAny> = {}
      strings.forEach((str) => {
        const schema = MustacheExtractor.extractSchema(str, this.log)
        const stringSchema = new ZodToStringMapper().renderField(schema)

        schemas[stringSchema] = schema
      })

      const schemaResults = Object.values(schemas)

      // If the schema is empty (no properties), just return basic string
      const noSchemasPresent = schemaResults.every((s) => {
        if (s instanceof z.ZodObject) {
          return Object.keys(s.shape).length === 0
        }
        return false
      })
      if (noSchemasPresent) {
        return z.string()
      }

      // Return an explicit function if we have only one schema defined
      if (schemaResults.length === 1) {
        return z.function({input: z.tuple([schemaResults[0]]), output: z.string()})
      }

      // Return a function with a union of schemas if we have multiple defined
      return z.function({
        input: z.tuple([z.union(schemaResults)]),
        output: z.string(),
      })
    }

    const schema = MustacheExtractor.extractSchema(strings[0], this.log)

    // If the schema is empty (no properties), just return basic string
    if (schema instanceof z.ZodObject && Object.keys(schema.shape).length === 0) {
      return z.string()
    }

    return z.function({input: z.tuple([schema]), output: z.string()})
  }

  private getAllJsonValues(config: Config): unknown[] {
    return config.rows.flatMap((row) =>
      row.values.flatMap((valueObj) => {
        if (config.valueType === 'JSON') {
          // Try to parse JSON from json field
          if (valueObj.value.json?.json) {
            try {
              return [JSON.parse(valueObj.value.json.json)]
            } catch (error) {
              console.warn(`Failed to parse JSON for ${config.key}:`, error)
            }
          }
          // Try to parse JSON from string field
          else if (valueObj.value.string) {
            try {
              return [JSON.parse(valueObj.value.string)]
            } catch (error) {
              console.warn(`Failed to parse JSON string for ${config.key}:`, error)
            }
          }
        }

        return []
      }),
    )
  }

  /**
   * Get all string values at a specific location in the config
   * @param config The configuration to extract strings from
   * @param location Array of keys representing the path to look for strings. Empty array for direct string values.
   * @returns Array of strings found at the specified location
   */
  private getAllStringsAtLocation(config: Config, location: string[]): string[] {
    if (location.length === 0) {
      // For empty location, just get direct string values
      return config.rows.flatMap((row) =>
        row.values.flatMap((valueObj) => (valueObj.value.string ? [valueObj.value.string] : [])),
      )
    }

    // For JSON values, we need to traverse the object
    return config.rows.flatMap((row) =>
      row.values.flatMap((valueObj) => {
        let jsonContent: unknown = null

        // Try to parse JSON from either json field or string field
        if (valueObj.value.json?.json) {
          try {
            jsonContent = JSON.parse(valueObj.value.json.json)
          } catch (error) {
            console.warn(`Failed to parse JSON for ${config.key}:`, error)
            return []
          }
        } else if (valueObj.value.string && config.valueType === 'JSON') {
          try {
            jsonContent = JSON.parse(valueObj.value.string)
          } catch (error) {
            console.warn(`Failed to parse JSON string for ${config.key}:`, error)
            return []
          }
        }

        if (!jsonContent) return []

        // Traverse the JSON object to the specified location
        let current: unknown = jsonContent
        for (const key of location) {
          if (current && typeof current === 'object' && key in current) {
            current = (current as Record<string, unknown>)[key]
          } else {
            return []
          }
        }

        // If we found a string at the location, return it
        return typeof current === 'string' ? [current] : []
      }),
    )
  }

  private inferFromConfig(config: Config, durationTypeMap?: DurationTypeMap): z.ZodTypeAny {
    const {key, valueType} = config

    switch (valueType) {
      case 'STRING': {
        return z.string()
      }

      case 'BOOL': {
        return z.boolean()
      }

      case 'INT': {
        return z.number().int()
      }

      case 'DOUBLE': {
        return z.number()
      }

      case 'STRING_LIST': {
        return z.array(z.string())
      }

      case 'DURATION': {
        return durationTypeMap?.() ?? z.number()
      }

      case 'JSON': {
        const jsonValues = this.getAllJsonValues(config)
        this.log('JSON values:', JSON.stringify(jsonValues, null, 2))

        if (jsonValues.length > 0) {
          try {
            // De-dup exact schemas
            const schemas: Record<string, z.ZodTypeAny> = {}
            jsonValues.forEach((json) => {
              const schema = new JsonToZodMapper().resolve(json)
              const stringSchema = new ZodToStringMapper().renderField(schema)

              schemas[stringSchema] = schema
            })

            const schemaResults = Object.values(schemas)

            // Return a single schema explicitly if we have only one defined
            if (schemaResults.length === 1) {
              return schemaResults[0]
            }

            // Return a union of schemas if we have multiple defined
            return z.union(schemaResults)
          } catch (error) {
            console.warn(`Error inferring JSON schema for ${key}:`, error)
          }
        }

        return z.union([z.array(z.any()), z.record(z.string(), z.any())])
      }

      case 'LOG_LEVEL': {
        return z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'])
      }

      default: {
        return z.any()
      }
    }
  }

  private replaceStringsWithMustache(
    schema: z.ZodTypeAny,
    config: Config,
    schemaLocation: string[] = [],
  ): z.ZodTypeAny {
    const typeName = schema.def.type

    // Handle enums explicitly
    if (typeName === 'enum') {
      return schema
    }

    // Check for both direct string and optional string
    if (
      schema instanceof z.ZodString ||
      (schema instanceof z.ZodOptional && schema.def.innerType instanceof z.ZodString)
    ) {
      const stringsAtLocation = this.getAllStringsAtLocation(config, schemaLocation)

      if (schema instanceof z.ZodOptional) {
        return this.createZodFunctionFromMustacheStrings(stringsAtLocation).optional()
      }

      return this.createZodFunctionFromMustacheStrings(stringsAtLocation)
    }

    if (schema instanceof z.ZodObject) {
      const newShape: Record<string, z.ZodTypeAny> = {}

      for (const [key, value] of Object.entries(schema.shape)) {
        newShape[key] = this.replaceStringsWithMustache(value as z.ZodTypeAny, config, [...schemaLocation, key])
      }

      return z.object(newShape)
    }

    // NOTE: no support for Mustache in Arrays or Unions

    // For all other types, just return as is
    return schema
  }

  // @ts-expect-error OK with not explicitly returning undefined
  private resolveUserSchema(config: Config, configFile: ConfigFile) {
    const {schemaKey} = config

    const schemaConfig = schemaKey
      ? configFile.configs.find((c) => c.key === schemaKey && c.configType === 'SCHEMA')
      : undefined

    if (schemaConfig) {
      for (const row of schemaConfig.rows) {
        for (const valueObj of row.values) {
          if (valueObj.value.schema?.schema) {
            const schemaStr = valueObj.value.schema.schema
            const result = secureEvaluateSchema(schemaStr)

            if (result.success && result.schema) {
              this.log(`Successfully parsed schema from schema config: ${schemaConfig.key}`)
              return result.schema
            }

            console.warn(`Failed to parse schema from schema config ${schemaConfig.key}: ${result.error}`)
          }
        }
      }
    }
  }
}
