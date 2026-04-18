import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {CrossSourceError, type ImportState, assertSourceMatches, readImportState} from '../migrate/import-state.js'
import {applyLocalMigration} from '../migrate/local-write.js'
import {type MigrationReportData} from '../migrate/migration-report.js'
import {PushConflictError} from '../migrate/push-strategy.js'
import {pushMigrationToCloud} from '../migrate/push-to-cloud.js'
import {UnknownSourceError, getSource} from '../migrate/registry.js'
import {type LegacyChange, NotYetImplementedError} from '../migrate/source.js'
import {applyLaunchBaseUrl} from '../migrate/sources/launch/api.js'
import {mintGiteaToken} from '../util/gitea-api.js'
import {displayUrl} from '../util/git-ops.js'
import {type AuthConfig, getActiveProfile, loadAuthConfig, resolveWorkspaceId} from '../util/token-storage.js'

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
      return this.err('--api-key is required. For --from launch you can also set LAUNCH_API_KEY in your environment.')
    }

    let workspaceContext: {authConfig: AuthConfig; workspaceId: string} | null = null
    if (flags.push) {
      const resolved = await this.resolvePushWorkspace(flags.workspace)
      if (typeof resolved === 'string') return this.err(resolved)
      workspaceContext = resolved
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
      const environments = await source.listEnvironments()

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

      if (flags.push && workspaceContext) {
        const {workspaceId} = workspaceContext
        this.log('Connecting to Gitea...')
        let repoUrl: string
        try {
          const tokenData = await mintGiteaToken(workspaceId, 'write', 'bootstrap')
          repoUrl = tokenData.repoUrl
        } catch (error) {
          return this.err(
            `Could not get Gitea credentials for workspace ${workspaceId}: ${String(error)}\n` +
              'Make sure the workspace is fully provisioned in the Quonfig app before pushing.',
          )
        }

        this.verboseLog('Migrate', {repoUrl: displayUrl(repoUrl)})

        const latestChangedAt = latestChangedAtOf(toProcess, sinceEpochMs ?? undefined)
        const importState: ImportState = {source: flags.from}
        if (latestChangedAt !== undefined) importState.lastProcessedAt = latestChangedAt

        this.log(`Pushing ${toProcess.length} change(s) to workspace ${workspaceId} (clone-and-stack)...`)
        try {
          const result = await pushMigrationToCloud({
            changes: toProcess,
            commitMessage: buildCommitMessage(flags.from, toProcess.length),
            importState,
            localDir: dir,
            remoteUrl: repoUrl,
            reportData: buildReportData(flags.from, toProcess.length),
            source,
          })

          this.log(
            result.committed
              ? `Pushed ${toProcess.length} change(s). commit=${result.commitSha?.slice(0, 8) ?? ''} action=${result.action}`
              : `No net changes produced by this run. Nothing to commit or push.`,
          )

          return {
            ...payload,
            action: result.action,
            commitSha: result.commitSha,
            committed: result.committed,
            pushed: true,
            workspaceId,
          }
        } catch (error) {
          if (error instanceof PushConflictError) {
            return this.err(
              `${error.message}\n\nRe-run \`qfg migrate --from ${flags.from} --workspace ${workspaceId} --push\` to pick up remote changes before retrying.`,
            )
          }

          throw error
        }
      }

      const latestLocalChangedAt = latestChangedAtOf(toProcess, sinceEpochMs ?? undefined)
      const localImportState: ImportState = {source: flags.from}
      if (latestLocalChangedAt !== undefined) {
        localImportState.lastProcessedAt = latestLocalChangedAt
      }

      this.log(`Fetched ${changes.length} change(s) from ${flags.from}; processing ${toProcess.length} into ${dir}.`)

      const localResult = await applyLocalMigration({
        changes: toProcess,
        commitMessage: buildCommitMessage(flags.from, toProcess.length),
        environments,
        importState: localImportState,
        localDir: dir,
        reportData: buildReportData(flags.from, toProcess.length),
        source,
      })

      this.log(
        localResult.committed
          ? `Committed ${toProcess.length} change(s). commit=${localResult.commitSha?.slice(0, 8) ?? ''} action=${localResult.action}`
          : `No net changes produced by this run. Nothing to commit.`,
      )

      return {
        ...payload,
        action: localResult.action,
        commitSha: localResult.commitSha,
        committed: localResult.committed,
      }
    } catch (error) {
      if (error instanceof NotYetImplementedError) return this.err(error.message)
      throw error
    }
  }

  private async resolvePushWorkspace(
    slugOrId: string | undefined,
  ): Promise<{authConfig: AuthConfig; workspaceId: string} | string> {
    const authConfig = await loadAuthConfig()
    if (!authConfig) return 'Not logged in. Run `qfg login` first, then re-run with --push.'

    if (slugOrId) {
      const resolved = resolveWorkspaceId(authConfig, slugOrId)
      return {authConfig, workspaceId: resolved ?? slugOrId}
    }

    const activeProfile = getActiveProfile()
    const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']
    if (!profile) {
      return 'No active profile found. Pass --workspace <slug> or run `qfg login` first.'
    }

    return {authConfig, workspaceId: profile.workspace}
  }
}

function latestChangedAtOf(changes: LegacyChange[], fallback: number | undefined): number | undefined {
  let latest: number | undefined
  for (const change of changes) {
    if (typeof change.changedAt === 'number' && (latest === undefined || change.changedAt > latest)) {
      latest = change.changedAt
    }
  }

  return latest ?? fallback
}

function buildCommitMessage(source: string, count: number): string {
  return `migrator: import ${count} change(s) from ${source}`
}

function buildReportData(source: string, count: number): MigrationReportData {
  return {
    cleanMappings: [],
    counts: {
      environmentsMapped: 0,
      flagsMigrated: count,
      itemsSkipped: 0,
      segmentsMigrated: 0,
    },
    dryRun: false,
    environmentMap: [],
    followUp: {mustFixBeforeCutover: [], reviewPostCutover: []},
    identifierMap: {},
    lossyMappings: [],
    source,
    unsupportedFeatures: [],
  }
}

function resolveTargetDir(dirFlag: string | undefined, cwd: string): string {
  if (dirFlag) return path.resolve(cwd, dirFlag)
  if (fs.existsSync(path.join(cwd, 'quonfig.json'))) return cwd
  return path.resolve(cwd, DEFAULT_DIR)
}

function computeSince(flags: {reset?: boolean; since?: string}, existing: ImportState | null): null | number {
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
