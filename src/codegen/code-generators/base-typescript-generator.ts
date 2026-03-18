import {z} from 'zod'

import {ZodToTypescriptMapper} from '../language-mappers/zod-to-typescript-mapper.js'
import {SchemaExtractor} from '../schema-extractor.js'
import {BaseGenerator, BaseGeneratorArgs} from './base-generator.js'

export abstract class BaseTypescriptGenerator extends BaseGenerator {
  protected MUSTACHE_IMPORT = "import Mustache from 'mustache'"
  private schemaExtractor: SchemaExtractor

  constructor({configFile, log}: BaseGeneratorArgs) {
    super({configFile, log})
    this.schemaExtractor = new SchemaExtractor(log)
  }

  protected configurations() {
    return this.configFile.configs
      .filter((config) => config.configType === 'FEATURE_FLAG' || config.configType === 'CONFIG')
      .filter((config) => config.rows.length > 0)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((config) => {
        const schema = this.schemaExtractor.execute({
          config,
          configFile: this.configFile,
          durationTypeMap: this.durationTypeMap,
        })

        return {
          configType: config.configType,
          hasFunction: schema && new ZodToTypescriptMapper().resolveType(schema).includes('=>'),
          key: config.key,
          schema,
          sendToClientSdk: config.sendToClientSdk ?? false,
        }
      })
  }

  protected durationTypeMap(): z.ZodTypeAny {
    return z.number()
  }

  abstract declarationGenerate(): string
  abstract generate(): string
}
