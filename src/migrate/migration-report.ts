import fs from 'node:fs'
import path from 'node:path'

import type {IdentifierMap} from './identifier-map.js'
import type {
  CoercedSentinelSummary,
  DroppedOverrideSummary,
  DuplicateResolutionSummary,
  SkippedConfigSummary,
} from './source.js'

export interface MigrationReportCounts {
  environmentsMapped: number
  flagsMigrated: number
  itemsSkipped: number
  segmentsMigrated: number
}

export interface CleanMapping {
  legacyKey: string
  quonfigKey: string
}

export interface LossyMapping {
  legacyKey: string
  quonfigKey: string
  reason: string
}

export interface UnsupportedFeature {
  feature: string
  note?: string
}

export interface EnvironmentMapEntry {
  quonfigName: string
  sourceName: string
}

export interface FollowUpChecklist {
  mustFixBeforeCutover: string[]
  reviewPostCutover: string[]
}

export interface MigrationReportData {
  cleanMappings: CleanMapping[]
  /**
   * Rule values that translate() coerced from a sentinel like Launch's
   * empty-string "no value set yet" to the typed default. Null when nothing
   * was coerced.
   */
  coercedSentinels?: CoercedSentinelSummary | null
  counts: MigrationReportCounts
  /**
   * Override sections that were dropped during translate() because the env.id was not
   * present in the source's env map (e.g. archived/deleted Reforge envs). Null when
   * nothing was dropped.
   */
  droppedOverrides?: DroppedOverrideSummary | null
  dryRun: boolean
  /**
   * Cross-type key collisions resolved by keeping the config side and deleting
   * the non-config type(s). Null when none were detected. Customers should
   * review each entry and clean up the source data to avoid the collision.
   */
  duplicateResolutions?: DuplicateResolutionSummary | null
  environmentMap: EnvironmentMapEntry[]
  followUp: FollowUpChecklist
  identifierMap: IdentifierMap
  lossyMappings: LossyMapping[]
  /**
   * Configs soft-skipped by translate() because the source data was invalid
   * (e.g. variant/valueType mismatch). Null when nothing was skipped.
   */
  skippedConfigs?: SkippedConfigSummary | null
  source: string
  unsupportedFeatures: UnsupportedFeature[]
}

const NONE = '_(none)_'

const renderCounts = (counts: MigrationReportCounts): string =>
  [
    '## Counts',
    '',
    `- Flags migrated: ${counts.flagsMigrated}`,
    `- Segments migrated: ${counts.segmentsMigrated}`,
    `- Environments mapped: ${counts.environmentsMapped}`,
    `- Items skipped: ${counts.itemsSkipped}`,
  ].join('\n')

const renderCleanMappings = (entries: CleanMapping[]): string => {
  const header = '## Clean mapping list'
  if (entries.length === 0) return `${header}\n\n${NONE}`
  const sorted = [...entries].sort((a, b) => a.legacyKey.localeCompare(b.legacyKey))
  const lines = sorted.map((e) => `- \`${e.legacyKey}\` → \`${e.quonfigKey}\``)
  return [header, '', ...lines].join('\n')
}

const renderLossyMappings = (entries: LossyMapping[]): string => {
  const header = '## Lossy mapping list'
  if (entries.length === 0) return `${header}\n\n${NONE}`
  const sorted = [...entries].sort((a, b) => a.legacyKey.localeCompare(b.legacyKey))
  const lines = sorted.map((e) => `- \`${e.legacyKey}\` → \`${e.quonfigKey}\` — ${e.reason}`)
  return [header, '', ...lines].join('\n')
}

const renderUnsupported = (entries: UnsupportedFeature[]): string => {
  const header = '## Unsupported feature list'
  if (entries.length === 0) return `${header}\n\n${NONE}`
  const lines = entries.map((e) => (e.note ? `- **${e.feature}** — ${e.note}` : `- ${e.feature}`))
  return [header, '', ...lines].join('\n')
}

const renderEnvironmentMap = (entries: EnvironmentMapEntry[]): string => {
  const header = '## Environment mapping table'
  if (entries.length === 0) return `${header}\n\n${NONE}`
  const sorted = [...entries].sort((a, b) => a.sourceName.localeCompare(b.sourceName))
  const rows = sorted.map((e) => `| ${e.sourceName} | ${e.quonfigName} |`)
  return [header, '', '| Source | Quonfig |', '| --- | --- |', ...rows].join('\n')
}

const renderIdentifierMap = (map: IdentifierMap): string => {
  const header = '## Identifier map'
  const keys = Object.keys(map)
  if (keys.length === 0) return `${header}\n\n${NONE}`
  const sorted = [...keys].sort()
  const rows = sorted.map((k) => `| \`${k}\` | \`${map[k]}\` |`)
  return [header, '', '| Legacy key | Quonfig key |', '| --- | --- |', ...rows].join('\n')
}

const renderDroppedOverrides = (dropped: DroppedOverrideSummary | null | undefined): null | string => {
  if (!dropped || dropped.total === 0) return null
  const envIds = Object.keys(dropped.byEnv).sort()
  const lines: string[] = [
    '## Dropped override sections',
    '',
    `Dropped **${dropped.total}** override section(s) referencing **${envIds.length}** env ID(s) not present in the source's env list (likely archived/deleted). If any of these envs are still in use, restore them in the source system and re-run the migration.`,
  ]
  for (const envId of envIds) {
    const perFlag = dropped.byEnv[envId]
    const totalForEnv = Object.values(perFlag).reduce((s, n) => s + n, 0)
    const flagCount = Object.keys(perFlag).length
    lines.push('', `### env-${envId} — ${totalForEnv} dropped from ${flagCount} flag(s)`, '')
    const sorted = Object.keys(perFlag).sort()
    for (const flagPath of sorted) {
      lines.push(`- \`${flagPath}\` (${perFlag[flagPath]})`)
    }
  }

  return lines.join('\n')
}

const renderDuplicateResolutions = (resolved: DuplicateResolutionSummary | null | undefined): null | string => {
  if (!resolved || resolved.total === 0) return null
  const lines: string[] = [
    '## Resolved cross-type duplicates',
    '',
    `Reforge had **${resolved.total}** key(s) present as both a config and a feature_flag (or other types) at the same time. qfg requires globally-unique keys, so the migrator kept the **config** side and deleted the other type(s). Review each and clean up the source system so the collision stops recurring.`,
    '',
  ]
  const sorted = [...resolved.entries].sort((a, b) => a.key.localeCompare(b.key))
  for (const entry of sorted) {
    lines.push(
      `- \`${entry.key}\` (${entry.collisionTypes.join(', ')}): kept \`${entry.kept}\`, deleted ${entry.deleted
        .map((p) => `\`${p}\``)
        .join(', ')}`,
    )
  }

  return lines.join('\n')
}

const renderCoercedSentinels = (coerced: CoercedSentinelSummary | null | undefined): null | string => {
  if (!coerced || coerced.total === 0) return null
  const envIds = Object.keys(coerced.byEnv).sort()
  const lines: string[] = [
    '## Coerced sentinel rule values',
    '',
    `Coerced **${coerced.total}** rule value(s) from Launch's "no value set yet" sentinel ({type:"string", value:""}) to the typed default for the surrounding config. The qfg-verify hook would otherwise reject these as type-mismatches and fail-stop the entire push. Affected envs: **${envIds.length}**. Review each and set a real default in the source system if needed.`,
  ]
  for (const envId of envIds) {
    const perFlag = coerced.byEnv[envId]
    const totalForEnv = Object.values(perFlag).reduce((s, n) => s + n, 0)
    const flagCount = Object.keys(perFlag).length
    lines.push('', `### env-${envId} — ${totalForEnv} coerced from ${flagCount} config(s)`, '')
    const sorted = Object.keys(perFlag).sort()
    for (const flagPath of sorted) {
      lines.push(`- \`${flagPath}\` (${perFlag[flagPath]})`)
    }
  }

  return lines.join('\n')
}

const renderSkippedConfigs = (skipped: null | SkippedConfigSummary | undefined): null | string => {
  if (!skipped || skipped.total === 0) return null
  const lines: string[] = [
    '## Skipped invalid configs',
    '',
    `Skipped **${skipped.total}** config(s) with structurally invalid source data — the migrator refused to emit them rather than ship broken data. Fix each in the source system and re-run.`,
    '',
  ]
  const sorted = [...skipped.entries].sort((a, b) => a.key.localeCompare(b.key))
  for (const entry of sorted) {
    lines.push(`- \`${entry.key}\` — ${entry.reason}`)
  }

  return lines.join('\n')
}

const renderFollowUp = (followUp: FollowUpChecklist): string => {
  const must =
    followUp.mustFixBeforeCutover.length === 0
      ? NONE
      : followUp.mustFixBeforeCutover.map((item) => `- [ ] ${item}`).join('\n')
  const review =
    followUp.reviewPostCutover.length === 0
      ? NONE
      : followUp.reviewPostCutover.map((item) => `- [ ] ${item}`).join('\n')
  return [
    '## Follow-up checklist',
    '',
    '### Must fix before cutover',
    '',
    must,
    '',
    '### Review post-cutover',
    '',
    review,
  ].join('\n')
}

export const buildMigrationReport = (data: MigrationReportData): string => {
  const sections: string[] = []

  if (data.dryRun) {
    sections.push('> **DRY RUN** — no files were written to the workspace during this run.')
  }

  sections.push(
    `# Migration Report (from ${data.source})`,
    `_Reflects only the changes produced by this run. Re-running overwrites this file._`,
    renderCounts(data.counts),
    renderCleanMappings(data.cleanMappings),
    renderLossyMappings(data.lossyMappings),
    renderUnsupported(data.unsupportedFeatures),
    renderEnvironmentMap(data.environmentMap),
    renderIdentifierMap(data.identifierMap),
  )

  const dropped = renderDroppedOverrides(data.droppedOverrides)
  if (dropped !== null) sections.push(dropped)

  const resolved = renderDuplicateResolutions(data.duplicateResolutions)
  if (resolved !== null) sections.push(resolved)

  const skipped = renderSkippedConfigs(data.skippedConfigs)
  if (skipped !== null) sections.push(skipped)

  const coerced = renderCoercedSentinels(data.coercedSentinels)
  if (coerced !== null) sections.push(coerced)

  sections.push(renderFollowUp(data.followUp))

  return sections.join('\n\n') + '\n'
}

export const migrationReportPath = (outputDir: string): string => path.join(outputDir, 'MIGRATION_REPORT.md')

export const writeMigrationReport = (outputDir: string, data: MigrationReportData): string => {
  fs.mkdirSync(outputDir, {recursive: true})
  const filePath = migrationReportPath(outputDir)
  fs.writeFileSync(filePath, buildMigrationReport(data), 'utf8')
  return filePath
}
