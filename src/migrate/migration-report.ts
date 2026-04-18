import fs from 'node:fs'
import path from 'node:path'

import type {IdentifierMap} from './identifier-map.js'

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
  counts: MigrationReportCounts
  dryRun: boolean
  environmentMap: EnvironmentMapEntry[]
  followUp: FollowUpChecklist
  identifierMap: IdentifierMap
  lossyMappings: LossyMapping[]
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
  const lines = sorted.map(
    (e) => `- \`${e.legacyKey}\` → \`${e.quonfigKey}\` — ${e.reason}`,
  )
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

  sections.push(`# Migration Report (from ${data.source})`)
  sections.push(
    `_Reflects only the changes produced by this run. Re-running overwrites this file._`,
  )
  sections.push(renderCounts(data.counts))
  sections.push(renderCleanMappings(data.cleanMappings))
  sections.push(renderLossyMappings(data.lossyMappings))
  sections.push(renderUnsupported(data.unsupportedFeatures))
  sections.push(renderEnvironmentMap(data.environmentMap))
  sections.push(renderIdentifierMap(data.identifierMap))
  sections.push(renderFollowUp(data.followUp))

  return sections.join('\n\n') + '\n'
}

export const migrationReportPath = (outputDir: string): string =>
  path.join(outputDir, 'MIGRATION_REPORT.md')

export const writeMigrationReport = (outputDir: string, data: MigrationReportData): string => {
  fs.mkdirSync(outputDir, {recursive: true})
  const filePath = migrationReportPath(outputDir)
  fs.writeFileSync(filePath, buildMigrationReport(data), 'utf8')
  return filePath
}
