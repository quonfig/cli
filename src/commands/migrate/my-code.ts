import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {type IdentifierMap} from '../../migrate/identifier-map.js'

const SKILL_NAME = 'qfg-migrate-code'
const SUPPORTED_SOURCES = new Set(['launch'])

function findIdentifierMap(startDir: string): {dir: string; map: IdentifierMap} | null {
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.qf', 'identifier-map.json')
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8')
      return {dir, map: JSON.parse(raw) as IdentifierMap}
    }

    if (path.dirname(dir) === dir) return null
  }
}

export default class MigrateMyCode extends BaseCommand {
  static description =
    'Migrate Launch SDK call sites in your codebase to Quonfig SDK call sites (invokes the qfg-migrate-code Claude skill)'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --from launch',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ]

  static flags = {
    'dry-run': Flags.boolean({
      default: false,
      description: 'Show what would be migrated without editing any files',
    }),
    from: Flags.string({
      default: 'launch',
      description: 'Legacy SDK to migrate from',
      options: ['launch'],
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(MigrateMyCode)

    if (!SUPPORTED_SOURCES.has(flags.from)) {
      return this.err(
        `Unsupported --from source: ${flags.from}. Only 'launch' is supported today; 'launchdarkly' and 'flagsmith' will follow.`,
      )
    }

    const found = findIdentifierMap(process.cwd())
    if (!found) {
      return this.err(
        `Could not find .qf/identifier-map.json in the current directory or any parent.\n\n` +
          `This file is produced by \`qfg migrate --from ${flags.from}\` and maps legacy keys to their Quonfig equivalents.\n` +
          `Run \`qfg migrate --from ${flags.from} --dir <your-workspace-dir>\` first, then re-run this command from your codebase.`,
      )
    }

    const {dir: workspaceDir, map: mappings} = found
    const mappingCount = Object.keys(mappings).length

    const relativeMapPath =
      path.relative(process.cwd(), path.join(workspaceDir, '.qf', 'identifier-map.json')) || '.qf/identifier-map.json'

    this.log(`Skill:         ${SKILL_NAME}`)
    this.log(`From:          ${flags.from}`)
    this.log(`Identifier map: ${relativeMapPath}`)
    this.log(`Found:         ${mappingCount} identifier remapping${mappingCount === 1 ? '' : 's'}`)
    if (flags['dry-run']) {
      this.log(`Mode:          dry-run (no files will be modified)`)
    }

    this.log('')
    this.log(`To run the migration, invoke Claude with the ${SKILL_NAME} skill. For example:`)
    this.log('')
    this.log(`  claude "/${SKILL_NAME}${flags['dry-run'] ? ' --dry-run' : ''}"`)
    this.log('')
    this.log(`The skill will:`)
    this.log(`  1. Scan for ${flags.from} SDK imports and call sites`)
    this.log(`  2. Propose edits using the ${mappingCount} key remapping${mappingCount === 1 ? '' : 's'} above`)
    this.log(`  3. Ask for approval before editing files`)
    this.log(`  4. Run your tests / typecheck afterwards if available`)
    this.log(`  5. Summarize anything it could not auto-migrate`)

    return {
      dryRun: flags['dry-run'],
      from: flags.from,
      identifierMapPath: path.join(workspaceDir, '.qf', 'identifier-map.json'),
      mappingCount,
      mappings,
      skill: SKILL_NAME,
    }
  }
}
