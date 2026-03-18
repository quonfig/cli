import {Flags} from '@oclif/core'
import {parse as parseJSON, stringify as stringifyJSON} from 'comment-json'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join, relative} from 'node:path'

import {BaseCommand} from '../index.js'
import {ConfigPaths, SupportedEditor, SupportedEditors, getServersConfig, resolveConfigPath} from '../services/mcp.js'
import autocomplete from '../util/autocomplete.js'
import {green} from '../util/color.js'
import isInteractive from '../util/is-interactive.js'

export default class Mcp extends BaseCommand {
  static description = 'Configure Quonfig MCP server for your AI assistant'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --editor cursor',
    '<%= config.bin %> <%= command.id %> --url http://local-app.goatsofquonfig.com:3003/api/v1/mcp',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    editor: Flags.string({
      description: 'Editor to configure (cursor, vscode, claude, windsurf)',
      options: [...SupportedEditors],
    }),
    url: Flags.string({
      description: 'Internal URL for testing (defaults to https://app.quonfig.com/api/v1/mcp)',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Mcp)

    // Select Editor
    let selectedEditor: SupportedEditor
    if (flags.editor) {
      selectedEditor = flags.editor as SupportedEditor
    } else if (isInteractive(flags)) {
      const editorChoice = await autocomplete({
        message: green('Which editor do you want to configure?'),
        source: SupportedEditors.map((editor) => ConfigPaths[editor].name),
      })

      if (!editorChoice) {
        return this.error('Editor selection is required')
      }

      // Find the editor key by name
      selectedEditor = Object.keys(ConfigPaths).find(
        (key) => ConfigPaths[key as SupportedEditor].name === editorChoice,
      ) as SupportedEditor
    } else {
      return this.error('--editor flag is required when interactive mode is not available')
    }

    // Determine config paths
    const cwd = process.cwd()
    const globalPath = resolveConfigPath(selectedEditor, false)
    const localPath = resolveConfigPath(selectedEditor, true)
    const fullLocalPath = localPath ? join(cwd, localPath) : undefined

    if (!globalPath) {
      return this.error(`Unsupported platform for editor: ${selectedEditor}`)
    }

    // Determine scope (global vs local)
    let configPathType: 'global' | 'local' = 'global'
    if (fullLocalPath && isInteractive(flags)) {
      const scopeChoice = await autocomplete({
        message: green('Configure global or project-local settings?'),
        source: [`Local (${relative(cwd, fullLocalPath)})`, `Global (${globalPath})`],
      })

      if (!scopeChoice) {
        return this.error('Scope selection is required')
      }

      configPathType = scopeChoice.startsWith('Local') ? 'local' : 'global'
    }

    const configPath = configPathType === 'local' ? fullLocalPath! : globalPath
    const displayConfigPath = configPathType === 'local' ? relative(cwd, configPath) : configPath

    this.log(`Configuring ${ConfigPaths[selectedEditor].name} at ${displayConfigPath}`)

    // Read/Parse existing config
    let editorConfig: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf8')
        const parsed = parseJSON(content)
        editorConfig = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<
          string,
          unknown
        >
        this.log(`✓ Read existing configuration`)
      } catch (error) {
        return this.error(`Failed to parse configuration file: ${error}`)
      }
    } else {
      this.log(`Configuration file not found, creating new one`)
    }

    // Get servers config section
    const serversConfig = getServersConfig(editorConfig)

    // Check for existing Quonfig entries
    const existingQuonfigEntries = Object.keys(serversConfig).filter((key) => /quonfig/i.test(key))

    // Determine entry key
    let targetEntryKey = 'quonfig'
    if (existingQuonfigEntries.length > 0 && isInteractive(flags)) {
      const choices = [`Add: ${targetEntryKey}`, ...existingQuonfigEntries.map((key) => `Update: ${key}`)]

      const choice = await autocomplete({
        message: green('Add a new MCP server or update an existing one?'),
        source: choices,
      })

      if (!choice) {
        return this.error('MCP server selection is required')
      }

      if (choice.startsWith('Update:')) {
        targetEntryKey = choice.replace('Update: ', '')
        this.log(`Updating existing MCP server entry: ${targetEntryKey}`)
      } else {
        this.log(`Adding new MCP server entry: ${targetEntryKey}`)
      }
    } else if (existingQuonfigEntries.length > 0) {
      // Non-interactive mode with existing entries - update the first one
      targetEntryKey = existingQuonfigEntries[0]
      this.log(`Updating existing MCP server entry: ${targetEntryKey}`)
    } else {
      this.log(`Adding new MCP server entry: ${targetEntryKey}`)
    }

    // Construct MCP endpoint URL and config
    const mcpUrl = flags.url || 'https://app.quonfig.com/api/v1/mcp'

    if (selectedEditor === 'claude-code') {
      serversConfig[targetEntryKey] = {
        type: 'http',
        url: mcpUrl,
      }
    } else {
      serversConfig[targetEntryKey] = {
        url: mcpUrl,
      }
    }

    // Write config file
    try {
      // Ensure directory exists
      mkdirSync(dirname(configPath), {recursive: true})

      const configString = stringifyJSON(editorConfig, null, 2)
      writeFileSync(configPath, configString)

      this.log(`✓ Configuration updated successfully`)
      this.log('')
      this.log('You may need to restart your editor for changes to take effect.')
    } catch (error) {
      return this.error(`Failed to write configuration file: ${error}`)
    }
  }
}
