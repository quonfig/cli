import {Flags} from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {z} from 'zod'

import type {JsonObj} from '../result.js'

import {BaseGenerator} from '../codegen/code-generators/base-generator.js'
import {BaseTypescriptGenerator} from '../codegen/code-generators/base-typescript-generator.js'
import {NodeTypeScriptGenerator} from '../codegen/code-generators/node-typescript-generator.js'
import {ReactTypeScriptGenerator} from '../codegen/code-generators/react-typescript-generator.js'
import {ConfigDownloader} from '../codegen/config-downloader.js'
import {type ConfigFile, SupportedLanguage} from '../codegen/types.js'
import {APICommand} from '../index.js'
import {createFileManager} from '../util/file-manager.js'

// base types
const nodeOrReactLanguageSpecificSchema = z.object({
  clientFileName: z.string().optional(),
  declarationFileName: z.string().optional(),
  outputDirectory: z.string().optional(),
})

/**
 * Types for parsed config schema
 *
 * {
 *   <react|node>: {
 *     clientFileName: string;
 *     declarationFileName: string;
 *     outputDirectory: string;
 *   },
 * }
 */
const requiredNodeOrReactLanguageSpecificSchema = nodeOrReactLanguageSpecificSchema.required()
const allLanguageEntries = {
  [SupportedLanguage.Node]: requiredNodeOrReactLanguageSpecificSchema,
  [SupportedLanguage.React]: requiredNodeOrReactLanguageSpecificSchema,
}

const parsedConfigSchema = z.object(allLanguageEntries)

/**
 * Types for input config schema
 *
 * {
 *   outputDiretory?: string;
 *   targets?: {
 *     <supported language>?: {
 *       outputDirectory: string;
 *       outputFileName: string;
 *     },
 *   },
 * }
 */
const allTargetsSchema = z.object({
  [SupportedLanguage.Node]: nodeOrReactLanguageSpecificSchema.optional(),
  [SupportedLanguage.React]: nodeOrReactLanguageSpecificSchema.optional(),
})
const inputConfigSchema = z.object({
  outputDirectory: z.string().optional(),
  targets: allTargetsSchema.optional(),
})

const CONFIG_NAME = 'quonfig.config.json'
const DEFAULT_CONFIG: {
  outputDirectory: string
  targets: Record<SupportedLanguage, {clientFileName: string; declarationFileName: string}>
} = {
  outputDirectory: 'generated',
  targets: {
    'node-ts': {
      clientFileName: 'quonfig-server.ts',
      declarationFileName: 'quonfig-server-types.d.ts',
    },
    'react-ts': {
      clientFileName: 'quonfig-client.ts',
      declarationFileName: 'quonfig-client-types.d.ts',
    },
  },
}

export default class Generate extends APICommand {
  /* eslint-disable no-irregular-whitespace */
  static description = `You can use the default type-generation configuration, or by provide your own via a quonfig.config.json file:

Format:
{
​  outputDirectory?: string;
​  targets?: {
​    <language key>?: {
​      outputDirectory?: string;
​      outputFileName?: string;
​    }
​  }
};

Example quonfig.config.json:
\`\`\`json
{
​  "outputDirectory": "path/to/your/directory",
​  "targets": {
​    "react-ts": {
​      "outputDirectory": "diff/path/to/your/directory",
​      "declarationFileName": "quonfig-client-types.d.ts",
​      "clientFileName": "quonfig-client.ts",
​    },
​    "node-ts": {
​      "declarationFileName": "quonfig-server-types.d.ts",
​      "clientFileName": "quonfig-server.ts",
​    }
​  }
}
\`\`\`
  `
  /* eslint-enable no-irregular-whitespace */

  static examples = [
    '<%= config.bin %> <%= command.id %> # react-ts only by default',
    '<%= config.bin %> <%= command.id %> --targets node-ts # node-ts only',
    '<%= config.bin %> <%= command.id %> --targets react-ts,node-ts # both node + react-ts',
    '<%= config.bin %> <%= command.id %> -o ./src/generated # specify output directory',
    '<%= config.bin %> <%= command.id %> --targets node-ts -o ./dist # combine with targets',
  ]

  static flags = {
    'output-directory': Flags.string({
      char: 'o',
      description: 'Override the output directory for generated files',
    }),
    targets: Flags.string({
      default: SupportedLanguage.React,
      description: `Determines for language/framework to generate code for (${Object.values(SupportedLanguage).join(', ')})`,
    }),
  }

  static summary = 'Generate type definitions for your Quonfig configuration'

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Generate)

    this.verboseLog('=== GENERATE COMMAND START ===')
    this.verboseLog(`Base API URL: ${process.env.QUONFIG_API_URL || 'Default'}`)

    try {
      // Look for and read local quonfig.config.json file
      const localConfig = await this.readLocalConfig(flags['output-directory'])

      // Use tarets flag override, otherwise fall back to local config
      const targets = flags.targets.split(',') || Object.keys(localConfig)

      this.verboseLog(`Language(s): ${targets.join(', ')}`)

      // Download the configuration using the APICommand's client
      const downloader = new ConfigDownloader(this)

      this.verboseLog('Downloading config...')
      const configFile = await downloader.downloadConfig()
      this.verboseLog('Config download complete.')

      const fileCreationPromises = []

      for (const target of targets) {
        // Resolve the language input
        const language = this.resolveLanguage(target)

        // Get language-specific config or fall back to global config
        const targetConfig = localConfig[language]
        const outputDir = targetConfig.outputDirectory

        this.verboseLog(`Output directory for ${target}: ${outputDir}`)

        this.verboseLog('Resolving generator...')
        const generator = this.resolveGenerator(language, configFile)
        console.log(`Generating ${language} code for configs...`)

        const generatedCode = generator.generate()
        this.verboseLog(`Code generation complete. Size: ${generatedCode.length}`)

        const fileManager = createFileManager({outputDirectory: outputDir, verboseLog: this.verboseLog.bind(this)})

        fileCreationPromises.push(fileManager.writeFile({data: generatedCode, filename: targetConfig.clientFileName}))

        if ([SupportedLanguage.Node, SupportedLanguage.React].includes(language)) {
          const declarationGeneratedCode = (generator as BaseTypescriptGenerator).declarationGenerate()
          this.verboseLog(`Code generation complete. Size: ${declarationGeneratedCode.length}`)

          fileCreationPromises.push(
            fileManager.writeFile({data: declarationGeneratedCode, filename: targetConfig.declarationFileName}),
          )
        }
      }

      await Promise.all(fileCreationPromises)
    } catch (error) {
      console.error('ERROR:', error)
      this.error(error as Error)
    }

    this.verboseLog('=== GENERATE COMMAND END ===')
    return {success: true}
  }

  private generateParsedConfig(
    jsonConfig: unknown = {},
    outputDirectoryOverride?: string,
  ): z.infer<typeof parsedConfigSchema> {
    const parsedConfig = inputConfigSchema.parse(jsonConfig)

    return Object.values(SupportedLanguage).reduce(
      (agg, language) => {
        const parsedLanguageConfig = parsedConfig.targets?.[language] || {}

        const languageConfig = {
          clientFileName: parsedLanguageConfig.clientFileName || DEFAULT_CONFIG.targets[language].clientFileName,
          declarationFileName:
            parsedLanguageConfig.declarationFileName || DEFAULT_CONFIG.targets[language].declarationFileName,
          outputDirectory:
            outputDirectoryOverride ||
            parsedLanguageConfig.outputDirectory ||
            parsedConfig.outputDirectory ||
            DEFAULT_CONFIG.outputDirectory,
        }

        agg[language] = languageConfig

        return agg
      },
      {} as z.infer<typeof parsedConfigSchema>,
    )
  }

  private async readLocalConfig(outputDirectoryOverride?: string): Promise<z.infer<typeof parsedConfigSchema>> {
    const configPath = path.join(process.cwd(), CONFIG_NAME)

    try {
      // Check if file exists
      await fs.promises.access(configPath, fs.constants.F_OK)

      this.verboseLog(`Found local ${CONFIG_NAME}`)

      // Read and parse the file
      const configContent = await fs.promises.readFile(configPath, 'utf8')

      const parsedConfig = JSON.parse(configContent)

      this.verboseLog(`Local config loaded from ${CONFIG_NAME}: ${JSON.stringify(parsedConfig, null, 2)}`)

      return this.generateParsedConfig(parsedConfig, outputDirectoryOverride)
    } catch (error) {
      // File doesn't exist or can't be read/parsed
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.verboseLog(`No ${CONFIG_NAME} file found in current directory.`)
      } else {
        this.error(`Error reading ${CONFIG_NAME}: ${error}`)
      }

      return this.generateParsedConfig({}, outputDirectoryOverride)
    }
  }

  private resolveGenerator(language: SupportedLanguage, configFile: ConfigFile): BaseGenerator {
    switch (language) {
      case SupportedLanguage.Node:
        return new NodeTypeScriptGenerator({configFile, log: this.verboseLog})
      case SupportedLanguage.React:
        return new ReactTypeScriptGenerator({configFile, log: this.verboseLog})
    }
  }

  private resolveLanguage(languageTarget: string | undefined): SupportedLanguage {
    const target = languageTarget?.toLowerCase() as SupportedLanguage

    if (!target || !Object.values(SupportedLanguage).includes(target)) {
      throw new Error(`Unsupported target: ${languageTarget}`)
    }

    return target
  }
}
