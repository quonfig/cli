import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {
  CrossSourceError,
  type ImportState,
  assertSourceMatches,
  readImportState,
} from '../migrate/import-state.js'
import {UnknownSourceError, getSource} from '../migrate/registry.js'
import {type LegacyChange, NotYetImplementedError} from '../migrate/source.js'
import {applyLaunchBaseUrl} from '../migrate/sources/launch/api.js'

const DEFAULT_DIR = 'quonfig-config'

export default class Migrate extends BaseCommand {
  static description =
    'Migrate flags and configs from a legacy feature-flag system into a Quonfig workspace.\n\n' +
    'Currently supported sources:\n' +
    '  launch — Reforge Launch (ported from launch-migrator)\n\n' +
    'See https://docs.quonfig.com/docs/migrating/from-launch for the step-by-step guide,\n' +
    'and https://docs.quonfig.com/docs/migrating/troubleshooting when something goes sideways.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY --dir ./quonfig-config',
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY --workspace acme-prod --push',
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY --dir ./quonfig-config --reset',
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY --dir ./quonfig-config --dry-run',
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY --dir ./quonfig-config --staging',
  ]

  static flags = {
    'api-key': Flags.string({
      description: 'API key for the legacy source (or set LAUNCH_API_KEY)',
      env: 'LAUNCH_API_KEY',
    }),
    dir: Flags.string({
      description:
        'Target local workspace directory. Defaults to cwd if it looks like a Quonfig workspace, otherwise ./quonfig-config.',
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Fetch and summarize changes without writing anything',
    }),
    from: Flags.string({
      description: 'Legacy source to migrate from',
      options: ['launch', 'launchdarkly', 'flagsmith'],
      required: true,
    }),
    push: Flags.boolean({
      default: false,
      description: 'After migrating to a local dir, also push to the given --workspace on Quonfig cloud',
    }),
    recent: Flags.integer({
      description: 'Import only the last N changes (useful for tire-kicking)',
    }),
    reset: Flags.boolean({
      default: false,
      description: 'Ignore the delta cursor and re-import everything from scratch',
    }),
    since: Flags.string({
      description: 'Override the delta cursor (epoch milliseconds or ISO-8601 timestamp)',
    }),
    staging: Flags.boolean({
      default: false,
      description: 'Hit the staging API for the source (dev-only)',
    }),
    workspace: Flags.string({
      description:
        'Quonfig cloud workspace slug to push to. Requires `qfg login` and is typically combined with --push.',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Migrate)

    if (flags.dir && flags.workspace && !flags.push) {
      return this.err(
        '`--dir` and `--workspace` are mutually exclusive unless `--push` is also passed. ' +
          'Pass `--push` to migrate locally and then push to the cloud workspace, or drop one of the flags.',
      )
    }

    if (!flags['api-key']) {
      return this.err(
        '--api-key is required. For --from launch you can also set LAUNCH_API_KEY in your environment.',
      )
    }

    const dir = resolveTargetDir(flags.dir, process.cwd())

    if (!flags.reset) {
      try {
        assertSourceMatches(dir, flags.from)
      } catch (error) {
        if (error instanceof CrossSourceError) return this.err(error.message)
        throw error
      }
    }

    if (flags.from === 'launch') {
      applyLaunchBaseUrl(flags.staging)
    }

    let source
    try {
      source = getSource(flags.from)
    } catch (error) {
      if (error instanceof UnknownSourceError) return this.err(error.message)
      throw error
    }

    try {
      await source.validateAuth(flags['api-key'])
      await source.listEnvironments()

      const existing = readImportState(dir)
      const sinceEpochMs = computeSince(flags, existing)

      const changes: LegacyChange[] = []
      for await (const change of source.fetchChanges(sinceEpochMs)) {
        changes.push(change)
      }

      const toProcess = flags.recent === undefined ? changes : changes.slice(-flags.recent)

      const payload: JsonObj = {
        dir,
        dryRun: flags['dry-run'],
        fetched: changes.length,
        from: flags.from,
        processed: toProcess.length,
        since: sinceEpochMs,
      }

      if (flags['dry-run']) {
        this.log(`Dry run: would migrate ${toProcess.length} change(s) from ${flags.from} into ${dir}.`)
        return payload
      }

      this.log(
        `Fetched ${changes.length} change(s) from ${flags.from}; processing ${toProcess.length}.\n` +
          'Writing files and pushing to cloud workspaces ships in follow-on beads (see project/plans/qfg-migrate.md).',
      )
      return payload
    } catch (error) {
      if (error instanceof NotYetImplementedError) return this.err(error.message)
      throw error
    }
  }
}

function resolveTargetDir(dirFlag: string | undefined, cwd: string): string {
  if (dirFlag) return path.resolve(cwd, dirFlag)
  if (fs.existsSync(path.join(cwd, 'quonfig.json'))) return cwd
  return path.resolve(cwd, DEFAULT_DIR)
}

function computeSince(
  flags: {reset?: boolean; since?: string},
  existing: ImportState | null,
): null | number {
  if (flags.reset) return null

  if (flags.since) {
    const asNumber = Number(flags.since)
    if (Number.isFinite(asNumber) && flags.since.trim() !== '') return asNumber
    const asDate = new Date(flags.since).getTime()
    return Number.isFinite(asDate) ? asDate : null
  }

  const value = existing?.lastProcessedAt
  if (value === undefined) return null
  if (typeof value === 'number') return value
  const asDate = new Date(value).getTime()
  return Number.isFinite(asDate) ? asDate : null
}
