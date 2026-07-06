import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {CrossSourceError, type ImportState, assertSourceMatches, readImportState} from '../migrate/import-state.js'
import {StrictKeysError} from '../migrate/key-rewriter.js'
import {applyLocalMigration, MigratorKeyCollisionError} from '../migrate/local-write.js'
import {buildPushConflictSuggestion} from '../migrate/migrate-suggestion.js'
import {type MigrationReportData, migrationReportPath} from '../migrate/migration-report.js'
import {type ConversionNote} from '../migrate/quonfig-target/report.js'
import {PushConflictError, PushHookRejectedError} from '../util/clone-and-stack-push.js'
import {MigratorVerifyError, pushMigrationToCloud} from '../migrate/push-to-cloud.js'
import {UnknownSourceError, getSource} from '../migrate/registry.js'
import {
  type CoercedSentinelSummary,
  type DroppedOverrideSummary,
  type DuplicateResolutionSummary,
  type LegacyChange,
  NotYetImplementedError,
  type SkippedConfigSummary,
} from '../migrate/source.js'
import {missingSourceApiKeyMessage, resolveSourceApiKey} from '../migrate/source-api-key.js'
import {applyFlagsmithBaseUrl} from '../migrate/sources/flagsmith/api.js'
import {setFlagsmithProjectId} from '../migrate/sources/flagsmith.js'
import {applyLaunchBaseUrl} from '../migrate/sources/launch/api.js'
import {applyLaunchDarklyBaseUrl} from '../migrate/sources/launchdarkly/api.js'
import {
  getLaunchDarklyRetentionHorizon,
  setLaunchDarklyFullSummary,
  setLaunchDarklyProjectKey,
} from '../migrate/sources/launchdarkly.js'
import {mintGiteaToken} from '../util/gitea-api.js'
import {displayUrl} from '../util/git-ops.js'
import {resolveWorkspaceUuid} from '../util/resolve-workspace.js'
import {type AuthConfig, loadAuthConfig} from '../util/token-storage.js'

const DEFAULT_DIR = 'quonfig-repo'

// How many fetched changes between progress lines during the (silent,
// paginated) change-history fetch. Large accounts page through thousands of
// changes 50 at a time; without periodic output the CLI looks frozen.
const FETCH_PROGRESS_INTERVAL = 1000

export default class Migrate extends BaseCommand {
  static description =
    'Migrate flags and configs from a legacy feature-flag system into a Quonfig workspace.\n\n' +
    'Currently supported sources:\n' +
    '  launch — Reforge Launch (ported from launch-migrator)\n\n' +
    'See https://docs.quonfig.com/docs/migrating/from-launch for the step-by-step guide,\n' +
    'and https://docs.quonfig.com/docs/migrating/troubleshooting when something goes sideways.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --from launchdarkly --source-api-key $LAUNCHDARKLY_API_KEY --dir ./quonfig-repo',
    '<%= config.bin %> <%= command.id %> --from launch --source-api-key $LAUNCH_API_KEY --workspace acme-prod --push',
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY --dir ./quonfig-repo --reset',
    '<%= config.bin %> <%= command.id %> --from launch --source-api-key $LAUNCH_API_KEY --dir ./quonfig-repo --dry-run',
    '<%= config.bin %> <%= command.id %> --from launch --source-api-key $LAUNCH_API_KEY --dir ./quonfig-repo --staging',
  ]

  static flags = {
    'api-key': Flags.string({
      description:
        'Deprecated alias for --source-api-key, kept for the `launch` source (or set LAUNCH_API_KEY). Prefer --source-api-key.',
      env: 'LAUNCH_API_KEY',
    }),
    dir: Flags.string({
      description:
        'Target local workspace directory. Defaults to cwd if it looks like a Quonfig workspace, otherwise ./quonfig-repo.',
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
    'full-summary': Flags.boolean({
      default: false,
      description:
        'Reify the full source-side audit log into per-change git commits ' +
        '(author = original user, date = original timestamp, message = change summary). ' +
        'Only valid on first-run imports — pass --reset to re-import everything from scratch with this flag.',
    }),
    project: Flags.string({
      description:
        'Source-system project identifier. For --from launchdarkly this is the project KEY (default: "default"; ' +
        'env: LAUNCHDARKLY_PROJECT_KEY). For --from flagsmith this is the numeric project ID (env: FLAGSMITH_PROJECT_ID). ' +
        'Ignored by --from launch.',
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
    'source-api-key': Flags.string({
      description:
        'API key for the legacy source. Set this, QUONFIG_MIGRATE_API_KEY, or the ' +
        'per-provider env var (LAUNCHDARKLY_API_KEY, LAUNCH_API_KEY, FLAGSMITH_API_KEY).',
      env: 'QUONFIG_MIGRATE_API_KEY',
    }),
    staging: Flags.boolean({
      default: false,
      description: 'Hit the staging API for the source (dev-only)',
    }),
    'strict-keys': Flags.boolean({
      default: false,
      description:
        'Refuse to migrate if any source key would need rewriting to satisfy Quonfig key rules ' +
        '(Policy A), instead of rewriting it. Use when you require byte-identical keys.',
    }),
    workspace: Flags.string({
      char: 'w',
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

    const sourceApiKey = resolveSourceApiKey({
      apiKeyFlag: flags['api-key'],
      from: flags.from,
      sourceApiKeyFlag: flags['source-api-key'],
    })
    if (!sourceApiKey) {
      return this.err(missingSourceApiKeyMessage(flags.from))
    }

    // --api-key is the deprecated launch-only alias (D8). Nudge non-launch users
    // toward the generalized flag, but don't fail — the key still resolved.
    if (flags['api-key'] && !flags['source-api-key'] && flags.from !== 'launch') {
      this.warn(
        `--api-key is a deprecated alias scoped to the \`launch\` source. For --from ${flags.from}, ` +
          'use --source-api-key (or the QUONFIG_MIGRATE_API_KEY env var) instead.',
      )
    }

    if (flags['full-summary'] && flags.recent !== undefined) {
      return this.err(
        '--full-summary and --recent are incompatible: --full-summary reifies the entire audit log into git history, ' +
          'so trimming changes with --recent would produce a misleading partial log. Drop one of the flags.',
      )
    }

    let workspaceContext: {authConfig: AuthConfig; workspaceId: string; orgSlug: string} | null = null
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

    // qfg-wbkj: --full-summary is a one-shot first-run import. Re-running it on
    // top of an incremental migration would produce a mixed history (one
    // collapsed commit on the bottom, per-change commits on top) which is
    // worse than either pure mode. Force the customer to either drop the flag
    // or explicitly --reset.
    if (flags['full-summary'] && !flags.reset && readImportState(dir) !== null) {
      return this.err(
        '--full-summary is only valid on first-run imports, but this directory has already been migrated incrementally ' +
          '(.qf/import-state.json exists). Either drop --full-summary to continue the incremental import, ' +
          'or re-import everything from scratch by passing --reset alongside --full-summary into a fresh directory.',
      )
    }

    if (flags.from === 'launch') {
      applyLaunchBaseUrl(flags.staging)
    }

    if (flags.from === 'launchdarkly') {
      // Thread run-scoped source config in before the first API call. The base
      // URL honours the LAUNCHDARKLY_API_URL escape hatch; --project (env-backed
      // by LAUNCHDARKLY_PROJECT_KEY) selects which LD project to snapshot;
      // --full-summary swaps the snapshot for the Phase-2 audit-log walk (the
      // walk's own resume cursor lives in os.tmpdir, not in `dir`).
      applyLaunchDarklyBaseUrl()
      setLaunchDarklyProjectKey(flags.project ?? process.env.LAUNCHDARKLY_PROJECT_KEY ?? 'default')
      setLaunchDarklyFullSummary(flags['full-summary'])
    }

    if (flags.from === 'flagsmith') {
      // Flagsmith projects are numeric IDs. --project is a string flag because
      // it's source-shared; we just pass it through. The Flagsmith source's
      // own resolveProjectId() honours FLAGSMITH_PROJECT_ID at module-load if
      // --project isn't passed.
      applyFlagsmithBaseUrl()
      const projectId = flags.project ?? process.env.FLAGSMITH_PROJECT_ID
      if (projectId) setFlagsmithProjectId(projectId)
    }

    let source
    try {
      source = getSource(flags.from)
    } catch (error) {
      if (error instanceof UnknownSourceError) return this.err(error.message)
      throw error
    }

    // The fetch and write phases below are silent for a long time on a large
    // account. Print a plan up front and a step line before each slow phase so
    // the CLI never looks frozen, even without --verbose.
    this.log(`Migrating from ${flags.from} into ${dir}.`)
    if (flags['dry-run']) {
      this.log('Mode: dry run — changes are summarized but nothing is written.')
    } else if (flags.push) {
      this.log('Mode: migrate to a local dir, then push to the Quonfig cloud workspace.')
    } else {
      this.log('Mode: local migration only — re-run with --push to also publish to a cloud workspace.')
    }

    this.log('')

    let duplicateResolutionsForWarn: DuplicateResolutionSummary | null = null
    // Set to the target dir once a local (non-push) migration commits, so the
    // `finally` block can print "what now?" guidance after the warnings.
    let localNextStepsDir: null | string = null
    try {
      this.log(`Authenticating with ${flags.from}...`)
      await source.validateAuth(sourceApiKey)
      this.log(`Reading the environment list from ${flags.from}...`)
      const environments = await source.listEnvironments()

      // Plan §4.1.1: tell the user the real history horizon BEFORE the slow
      // Phase-2 walk starts. validateAuth populated this for LD under
      // --full-summary; the message also names the Developer-plan ≤ 30 days
      // ceiling explicitly when that's what we observed.
      if (flags.from === 'launchdarkly' && flags['full-summary']) {
        const horizon = getLaunchDarklyRetentionHorizon()
        if (horizon) this.log(`History pre-flight: ${horizon.label}`)
      }

      const existing = readImportState(dir)
      const sinceEpochMs = computeSince(flags, existing)

      this.log(`Fetching change history from ${flags.from} — this can take a few minutes for a large account...`)
      const changes: LegacyChange[] = []
      let lastReportedFetch = 0
      for await (const change of source.fetchChanges(sinceEpochMs, (fetched) => {
        if (fetched - lastReportedFetch >= FETCH_PROGRESS_INTERVAL) {
          lastReportedFetch = fetched
          this.log(`  ...fetched ${fetched} change(s) so far`)
        }
      })) {
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
        const {workspaceId, orgSlug} = workspaceContext
        this.log('Connecting to Gitea...')
        let repoUrl: string
        try {
          const tokenData = await mintGiteaToken(workspaceId, orgSlug, 'write', 'bootstrap')
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

        this.log(
          flags['full-summary']
            ? `Pushing ${toProcess.length} change(s) to workspace ${workspaceId} as per-change audit-log commits...`
            : `Pushing ${toProcess.length} change(s) to workspace ${workspaceId} (clone-and-stack)...`,
        )
        try {
          const result = await pushMigrationToCloud({
            changes: toProcess,
            environments,
            fullHistory: flags['full-summary'],
            importState,
            localDir: dir,
            remoteUrl: repoUrl,
            reportData: buildReportData(flags.from),
            source,
            strictKeys: flags['strict-keys'],
          })

          duplicateResolutionsForWarn = result.duplicateResolutions
          this.log(
            result.committed
              ? `Pushed ${toProcess.length} change(s). commit=${result.commitSha?.slice(0, 8) ?? ''} action=${result.action}`
              : `No net changes produced by this run. Nothing to commit or push.`,
          )
          this.log(
            `Migration report written to ${migrationReportPath(dir)} — review it before cutover ` +
              '(it lives in the hidden .qf/ directory).',
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
          if (error instanceof PushHookRejectedError) {
            return this.err(
              `${error.message}\n\nThe remote validation hook rejected the push. Fix the errors reported above (typically in the source system or by editing the local files in ${dir}), then re-run with --push. You can re-run \`qfg verify ${dir}\` locally to confirm the fixes before pushing.`,
            )
          }

          if (error instanceof PushConflictError) {
            return this.err(
              `${error.message}\n\n${buildPushConflictSuggestion({from: flags.from, userWorkspaceFlag: flags.workspace})}`,
            )
          }

          if (error instanceof MigratorVerifyError) {
            return this.err(
              `${error.message}\n\nThe migrated workspace was written to ${dir} but was NOT pushed. ` +
                `Fix the issues above (typically in the source system or by editing the local files), then re-run with --push. ` +
                `You can re-run \`qfg verify ${dir}\` locally to confirm the fixes before pushing.`,
            )
          }

          if (error instanceof MigratorKeyCollisionError) {
            return this.err(error.message)
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
        environments,
        fullHistory: flags['full-summary'],
        importState: localImportState,
        localDir: dir,
        reportData: buildReportData(flags.from),
        source,
        strictKeys: flags['strict-keys'],
      })

      duplicateResolutionsForWarn = localResult.duplicateResolutions
      this.log(
        localResult.committed
          ? `Committed ${toProcess.length} change(s). commit=${localResult.commitSha?.slice(0, 8) ?? ''} action=${localResult.action}`
          : `No net changes produced by this run. Nothing to commit.`,
      )
      // Print "what now?" guidance from the `finally` block (after the
      // warnings) so it is the last thing the user sees.
      if (localResult.committed) localNextStepsDir = dir

      return {
        ...payload,
        action: localResult.action,
        commitSha: localResult.commitSha,
        committed: localResult.committed,
      }
    } catch (error) {
      if (error instanceof NotYetImplementedError) return this.err(error.message)
      if (error instanceof MigratorKeyCollisionError) return this.err(error.message)
      if (error instanceof StrictKeysError) return this.err(error.message)
      throw error
    } finally {
      // Surface source-level warnings even if apply/push threw (e.g.
      // detectDuplicateKeys). The source accumulator holds the data regardless.
      warnAboutDroppedOverrides(this, source.getDroppedOverrides?.() ?? null)
      warnAboutSkippedConfigs(this, source.getSkippedConfigs?.() ?? null)
      warnAboutCoercedSentinels(this, source.getCoercedSentinels?.() ?? null)
      warnAboutDuplicateResolutions(this, duplicateResolutionsForWarn)
      warnAboutConversionNotes(this, source.getConversionNotes?.() ?? null)
      if (localNextStepsDir) this.printLocalNextSteps(localNextStepsDir)
    }
  }

  /**
   * After a local (non-push) migration commits, the user is left at a prompt
   * with a fresh directory and no obvious next move. Spell out the review →
   * push flow explicitly.
   */
  private printLocalNextSteps(dir: string): void {
    this.log('')
    this.log('Migration written to a local directory — nothing has been pushed to Quonfig cloud yet.')
    this.log('')
    this.log('Next steps:')
    this.log(`  1. Review the migrated config files in ${dir}`)
    this.log('  2. Read the migration report — it lists every config that was skipped,')
    this.log('     coerced, or needs a manual follow-up:')
    this.log(`       ${migrationReportPath(dir)}`)
    this.log('     (it lives in the hidden .qf/ directory — use `ls -a` to see it)')
    this.log('  3. Publish to a Quonfig workspace once the migration looks right:')
    this.log(`       qfg push --dir ${dir} --workspace <org-slug>/<workspace-slug>`)
    this.log('     (run `qfg login` first if you have not). You can also re-run this command')
    this.log('     with `--push --workspace <org-slug>/<workspace-slug>` to migrate and push')
    this.log('     in one step.')
    this.log('')
    this.log('Re-running `qfg migrate` later picks up only the changes made since this run.')
  }

  private async resolvePushWorkspace(
    slugOrId: string | undefined,
  ): Promise<{authConfig: AuthConfig; workspaceId: string; orgSlug: string} | string> {
    const authConfig = await loadAuthConfig()
    if (!authConfig) return 'Not logged in. Run `qfg login` first, then re-run with --push.'

    // For migrate --push we need both the workspaceId and the owning org's
    // slug (so mintGiteaToken can pick the right per-org WorkOS token).
    // resolveWorkspaceUuid handles both --workspace (org/ws form) and the
    // saved-profile fallback uniformly.
    const resolved = await resolveWorkspaceUuid(this, slugOrId)
    return {authConfig, workspaceId: resolved.workspaceId, orgSlug: resolved.orgSlug}
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

function buildReportData(source: string): MigrationReportData {
  // Counts are placeholders; applyLocalMigration / pushMigrationToCloud
  // override `counts` after writing files so they reflect what actually
  // landed on disk (qfg-7eig). The commit message is also derived from those
  // counts inside the apply function — it is not built here.
  return {
    cleanMappings: [],
    counts: {
      configsMigrated: 0,
      environmentsMapped: 0,
      flagsMigrated: 0,
      itemsSkipped: 0,
      logLevelsMigrated: 0,
      schemasMigrated: 0,
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

function warnAboutDroppedOverrides(cmd: BaseCommand, dropped: DroppedOverrideSummary | null): void {
  if (!dropped || dropped.total === 0) return
  const envIds = Object.keys(dropped.byEnv).sort()
  cmd.warn(
    `Dropped ${dropped.total} override section(s) referencing ${envIds.length} env ID(s) not present in the source's env list (likely archived/deleted):`,
  )
  for (const envId of envIds) {
    const perFlag = dropped.byEnv[envId]
    const totalForEnv = Object.values(perFlag).reduce((s, n) => s + n, 0)
    cmd.warn(`  env-${envId}: ${totalForEnv} dropped from ${Object.keys(perFlag).length} flag(s)`)
    for (const flagPath of Object.keys(perFlag).sort()) {
      cmd.warn(`    - ${flagPath} (${perFlag[flagPath]})`)
    }
  }

  cmd.warn(
    `If any of these envs are still in use, restore them in the source system and re-run the migration. Full detail is also written to .qf/MIGRATION_REPORT.md.`,
  )
}

function warnAboutDuplicateResolutions(cmd: BaseCommand, resolved: DuplicateResolutionSummary | null): void {
  if (!resolved || resolved.total === 0) return
  cmd.warn(
    `Resolved ${resolved.total} cross-type key collision(s) in the source data by keeping the config side and deleting the other type(s). Review each and clean up the source system so the collision stops recurring:`,
  )
  const sorted = [...resolved.entries].sort((a, b) => a.key.localeCompare(b.key))
  for (const entry of sorted) {
    cmd.warn(
      `  ${entry.key} (${entry.collisionTypes.join(', ')}): kept ${entry.kept}, deleted ${entry.deleted.join(', ')}`,
    )
  }

  cmd.warn('Full detail is also written to .qf/MIGRATION_REPORT.md.')
}

function warnAboutCoercedSentinels(cmd: BaseCommand, coerced: CoercedSentinelSummary | null): void {
  if (!coerced || coerced.total === 0) return
  const envIds = Object.keys(coerced.byEnv).sort()
  cmd.warn(
    `Coerced ${coerced.total} sentinel rule value(s) from Launch's "no value set yet" sentinel ({type:"string", value:""}) to the typed default for the surrounding config. Without coercion the qfg-verify hook would reject these as type-mismatches and fail-stop the entire push:`,
  )
  for (const envId of envIds) {
    const perFlag = coerced.byEnv[envId]
    const totalForEnv = Object.values(perFlag).reduce((s, n) => s + n, 0)
    cmd.warn(`  env-${envId}: ${totalForEnv} coerced from ${Object.keys(perFlag).length} config(s)`)
    for (const flagPath of Object.keys(perFlag).sort()) {
      cmd.warn(`    - ${flagPath} (${perFlag[flagPath]})`)
    }
  }

  cmd.warn(
    `If you want a real default for these rules, set one in the source system and re-run the migration. Full detail is also written to .qf/MIGRATION_REPORT.md.`,
  )
}

function warnAboutConversionNotes(cmd: BaseCommand, notes: ConversionNote[] | null): void {
  if (!notes || notes.length === 0) return
  const rebucketed = notes.filter((n) => n.category === 'rebucketed-rollout')
  if (rebucketed.length > 0) {
    cmd.warn(
      `${rebucketed.length} flag(s)/segment(s) use a percentage rollout — LaunchDarkly and Quonfig bucket users ` +
        `differently, so individual user assignments WILL change after migration (the rollout percentage is preserved). ` +
        `See the "Users will be re-bucketed" section of .qf/MIGRATION_REPORT.md.`,
    )
  }

  const other = notes.filter((n) => n.category !== 'rebucketed-rollout' && n.category !== 'skipped-config')
  if (other.length > 0) {
    cmd.warn(
      `${other.length} source concept(s) could not be converted exactly (dropped prerequisites, lossy individual ` +
        `targets, etc.). Nothing was silently dropped — see the "Conversion notes" section of .qf/MIGRATION_REPORT.md.`,
    )
  }
}

function warnAboutSkippedConfigs(cmd: BaseCommand, skipped: null | SkippedConfigSummary): void {
  if (!skipped || skipped.total === 0) return
  cmd.warn(
    `Skipped ${skipped.total} invalid config(s) from the source system — these were not written to the workspace. Fix each in the source system and re-run:`,
  )
  const sorted = [...skipped.entries].sort((a, b) => a.key.localeCompare(b.key))
  for (const entry of sorted) {
    cmd.warn(`  ${entry.key}: ${entry.reason}`)
  }

  cmd.warn('Full detail is also written to .qf/MIGRATION_REPORT.md.')
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
