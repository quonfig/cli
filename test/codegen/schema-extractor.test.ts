import {expect} from 'chai'
import {oneLineTrim} from 'common-tags'
import {z} from 'zod'

import {ZodToStringMapper} from '../../src/codegen/language-mappers/zod-to-string-mapper.js'
import {SchemaExtractor} from '../../src/codegen/schema-extractor.js'
import {type Config, type ConfigFile} from '../../src/codegen/types.js'

// Custom duration type map returning a string
const durationTypeMap = () => z.string()

function expectSchemaMatchesString(schema: z.ZodTypeAny, expectedString: string): void {
  const schemaString = new ZodToStringMapper().resolveType(schema).split(' ').join('')
  const expectedStringResult = expectedString.split(' ').join('')

  expect(oneLineTrim(schemaString)).to.equal(oneLineTrim(expectedStringResult))
}

describe('SchemaExtractor', () => {
  let mockLog: (category: string | unknown, message?: unknown) => void
  let schemaExtractor: SchemaExtractor

  beforeEach(() => {
    mockLog = () => {}
    schemaExtractor = new SchemaExtractor(mockLog)
  })

  describe('execute', () => {
    it('should use user-defined schema when available', () => {
      const schemaConfig: Config = {
        configType: 'SCHEMA',
        key: 'user_schema',
        rows: [
          {
            values: [
              {
                value: {
                  schema: {
                    schema: 'z.object({ name: z.string(), age: z.number().int() })',
                    schemaType: 'zod',
                  },
                },
              },
            ],
          },
        ],
        valueType: 'JSON',
      }

      // Configuration is empty, so we know user-defined schema will be used in our assertion
      const config: Config = {
        configType: 'CONFIG',
        key: 'user_config',
        rows: [],
        schemaKey: 'user_schema',
        valueType: 'JSON',
      }

      // Create the config file containing both configs
      const configFile: ConfigFile = {
        configs: [config, schemaConfig],
      }

      const result = schemaExtractor.execute({config, configFile})

      expectSchemaMatchesString(
        result,
        `
          z.object({
            name: z.string();
            age: z.number().int()
          })
        `,
      )
    })

    it('should infer schema when no user-defined schema is available', () => {
      // Create a config without a schema reference
      const config: Config = {
        configType: 'CONFIG',
        key: 'string_config',
        rows: [
          {
            values: [
              {
                value: {
                  string: 'test value',
                },
              },
            ],
          },
        ],
        valueType: 'STRING',
      }

      const configFile: ConfigFile = {
        configs: [config],
      }

      const result = schemaExtractor.execute({config, configFile})
      expectSchemaMatchesString(result, 'z.string()')
    })

    it('should infer a union of schema when multiple schemas are found', () => {
      // Create a config without a schema reference
      const config: Config = {
        configType: 'CONFIG',
        key: 'json_config',
        rows: [
          {
            values: [
              {
                value: {
                  json: {
                    json: JSON.stringify({
                      enterprise: 5000,
                      premium: 500,
                      standard: 100,
                    }),
                  },
                },
              },
            ],
          },
          {
            values: [
              {
                value: {
                  json: {
                    json: JSON.stringify({
                      freemium: 0,
                      premium: 500,
                      standard: 100,
                    }),
                  },
                },
              },
            ],
          },
        ],
        valueType: 'JSON',
      }

      const configFile: ConfigFile = {
        configs: [config],
      }

      const result = schemaExtractor.execute({config, configFile})

      expectSchemaMatchesString(
        result,
        `
          z.union(
            [
              z.object({enterprise: z.number(); premium: z.number(); standard: z.number()}),
              z.object({freemium: z.number(); premium: z.number(); standard: z.number()})
            ]
          )
        `,
      )
    })

    it('should use custom duration type map when provided', () => {
      // Create a config with DURATION type
      const config: Config = {
        configType: 'CONFIG',
        key: 'duration_config',
        rows: [
          {
            values: [
              {
                value: {
                  int: 5000, // 5 seconds in ms
                },
              },
            ],
          },
        ],
        valueType: 'DURATION',
      }

      const configFile: ConfigFile = {
        configs: [config],
      }

      const result = schemaExtractor.execute({config, configFile, durationTypeMap})

      expectSchemaMatchesString(result, `z.string()`)
    })

    it('should replace strings with Mustache templates when found', () => {
      // Create a config with a Mustache template
      const config: Config = {
        configType: 'CONFIG',
        key: 'template_config',
        rows: [
          {
            values: [
              {
                value: {
                  string: 'Hello, {{name}}!',
                },
              },
            ],
          },
        ],
        valueType: 'STRING',
      }

      const configFile: ConfigFile = {
        configs: [config],
      }

      const result = schemaExtractor.execute({config, configFile})

      expectSchemaMatchesString(
        result,
        `
        z.function({
          input: z.tuple([
            z.object({
              name: z.string()
            })
          ]),
          output: z.string()
        })
        `,
      )
    })

    it('should replace strings with a union of Mustache templates when found', () => {
      // Create a config with a Mustache template
      const config: Config = {
        configType: 'CONFIG',
        key: 'template_config',
        rows: [
          {
            values: [
              {
                value: {
                  string: 'Hello, {{name}}!',
                },
              },
              {
                value: {
                  string: 'Hello, {{differentName}}!',
                },
              },
            ],
          },
        ],
        valueType: 'STRING',
      }

      const configFile: ConfigFile = {
        configs: [config],
      }

      const result = schemaExtractor.execute({config, configFile})

      expectSchemaMatchesString(
        result,
        `
        z.function({
          input: z.tuple([
            z.union([
              z.object({
                name: z.string()
              }),
              z.object({
                differentName: z.string()
              })
            ])
          ]),
          output: z.string()
        })
        `,
      )
    })
  })
})
