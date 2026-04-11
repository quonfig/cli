import * as fs from 'node:fs'
import * as path from 'node:path'

import type {Config, ConfigFile, ConfigRow, ConfigValue, SchemaFile} from './types.js'

// Shape of a single rule's value in git-native JSON files
interface GitValue {
  type: string
  value: unknown
}

// Shape of a rule entry in a git-native JSON file
interface GitRule {
  criteria: unknown[]
  value: GitValue
}

// Shape of an environment block in a git-native JSON file
interface GitEnvironment {
  id: string
  rules: GitRule[]
}

// Shape of a raw git-native config/feature-flag JSON file
interface GitConfigJson {
  key: string
  type: string
  valueType: string
  sendToClientSdk?: boolean
  schemaKey?: string
  default?: {rules: GitRule[]}
  environments?: GitEnvironment[]
  variants?: unknown[]
}

function mapGitValue(gitValue: GitValue): ConfigValue {
  const {type, value} = gitValue

  switch (type) {
    case 'bool': {
      return {value: {bool: value as boolean}}
    }

    case 'int': {
      return {value: {int: value as number}}
    }

    case 'json': {
      return {value: {json: {json: value as string}}}
    }

    case 'log_level': {
      return {value: {logLevel: value as string}}
    }

    case 'string_list': {
      return {value: {string: JSON.stringify(value)}}
    }

    case 'string':
    default: {
      return {value: {string: value as string}}
    }
  }
}

function buildRows(gitConfig: GitConfigJson): ConfigRow[] {
  const allRules: GitRule[] = [
    ...(gitConfig.default?.rules ?? []),
    ...(gitConfig.environments ?? []).flatMap((env) => env.rules),
  ]

  return allRules.map((rule) => ({
    values: [mapGitValue(rule.value)],
  }))
}

function mapConfigType(gitType: string): 'CONFIG' | 'FEATURE_FLAG' {
  return gitType === 'feature_flag' ? 'FEATURE_FLAG' : 'CONFIG'
}

function mapValueType(gitValueType: string): Config['valueType'] {
  return gitValueType.toUpperCase() as Config['valueType']
}

async function readJsonFiles(dir: string): Promise<{filePath: string; data: unknown}[]> {
  try {
    const entries = await fs.promises.readdir(dir)
    const jsonFiles = entries.filter((f) => f.endsWith('.json'))
    return Promise.all(
      jsonFiles.map(async (file) => {
        const filePath = path.join(dir, file)
        const content = await fs.promises.readFile(filePath, 'utf8')
        return {filePath, data: JSON.parse(content)}
      }),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export class LocalConfigReader {
  constructor(private dir: string) {}

  async read(): Promise<ConfigFile> {
    // Validate dir exists
    try {
      await fs.promises.access(this.dir, fs.constants.F_OK)
    } catch {
      throw new Error(
        `Directory not found: ${this.dir}. Run \`qfg pull --dir ${this.dir}\` to clone it.`,
      )
    }

    // Validate it's a quonfig workspace
    const quonfigJsonPath = path.join(this.dir, 'quonfig.json')
    try {
      await fs.promises.access(quonfigJsonPath, fs.constants.F_OK)
    } catch {
      throw new Error(
        `${this.dir} does not look like a Quonfig workspace. Is this the right directory?`,
      )
    }

    // Read configs and feature-flags
    const [configFiles, flagFiles] = await Promise.all([
      readJsonFiles(path.join(this.dir, 'configs')),
      readJsonFiles(path.join(this.dir, 'feature-flags')),
    ])

    const configs: Config[] = []

    for (const {filePath, data} of [...configFiles, ...flagFiles]) {
      const gitConfig = data as GitConfigJson

      if (!gitConfig.key || !gitConfig.type || !gitConfig.valueType) {
        console.warn(`Skipping malformed config file: ${filePath}`)
        continue
      }

      const rows = buildRows(gitConfig)

      configs.push({
        configType: mapConfigType(gitConfig.type),
        key: gitConfig.key,
        rows,
        schemaKey: gitConfig.schemaKey,
        sendToClientSdk: gitConfig.sendToClientSdk,
        valueType: mapValueType(gitConfig.valueType),
      })
    }

    // Read schemas
    const schemaFiles = await readJsonFiles(path.join(this.dir, 'schemas'))
    const schemas: SchemaFile[] = schemaFiles.map(({filePath, data}) => ({
      path: filePath,
      schema: data as Record<string, unknown>,
    }))

    if (configs.length === 0) {
      console.warn('No configs or feature-flags found in workspace. Generated types will be empty.')
    }

    return {configs, schemas}
  }
}
