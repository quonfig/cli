import fs from 'node:fs'
import path from 'node:path'

import type {IdentifierMap} from './identifier-map.js'
import type {KeyRewrite} from './key-rewriter.js'
import type {ConversionNote, ConversionNoteCategory} from './quonfig-target/report.js'
import type {
  CoercedSentinelSummary,
  DroppedOverrideSummary,
  DuplicateResolutionSummary,
  EnvironmentMapEntry,
  SkippedConfigSummary,
} from './source.js'

export type {EnvironmentMapEntry} from './source.js'

export interface MigrationReportCounts {
  configsMigrated: number
  environmentsMapped: number
  flagsMigrated: number
  itemsSkipped: number
  logLevelsMigrated: number
  schemasMigrated: number
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
  /**
   * Structured conversion notes from a provider's `translate()` — re-bucketed
   * rollouts, dropped prerequisites, lossy individual-target conversions, etc.
   * (the LaunchDarkly `quonfig-target/report.ts` set). Rendered into the
   * "Users will be re-bucketed" + "Conversion notes" sections. Undefined or
   * empty when the source emitted none.
   */
  conversionNotes?: ConversionNote[]
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
  /**
   * qfg-6na9.3: source keys the migrator rewrote so the workspace is 100%
   * Policy-A conformant (bad charset, FS-floor, or collision). The renamed key
   * is what the customer's SDK code must now look up. Null/empty when every
   * source key already conformed (e.g. every LaunchDarkly import).
   */
  keyRewrites?: KeyRewrite[] | null
  lossyMappings: LossyMapping[]
  /**
   * qfg-l8uz: source maintainerId → email pairs. Rendered as a sub-table on
   * `## Identifier map` so the reader sees who owned each dropped-maintainer
   * note, and consumed by the renderer to decorate the dropped-maintainer
   * rollup with emails. Optional/undefined when the source has no member
   * lookup (or it failed) — both the table and the decoration just no-op.
   */
  maintainerMap?: null | Record<string, string>
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
    `- Configs migrated: ${counts.configsMigrated}`,
    `- Segments migrated: ${counts.segmentsMigrated}`,
    `- Schemas migrated: ${counts.schemasMigrated}`,
    `- Log levels migrated: ${counts.logLevelsMigrated}`,
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

const renderIdentifierMap = (map: IdentifierMap, maintainerMap?: null | Record<string, string>): string => {
  const header = '## Identifier map'
  const sections: string[] = []
  const keys = Object.keys(map)
  if (keys.length > 0) {
    const sorted = [...keys].sort()
    const rows = sorted.map((k) => `| \`${k}\` | \`${map[k]}\` |`)
    sections.push(['### Legacy keys', '', '| Legacy key | Quonfig key |', '| --- | --- |', ...rows].join('\n'))
  }

  const maintainerIds = maintainerMap ? Object.keys(maintainerMap) : []
  if (maintainerIds.length > 0) {
    const sorted = [...maintainerIds].sort()
    const rows = sorted.map((id) => `| \`${id}\` | ${maintainerMap![id]} |`)
    sections.push(
      [
        '### Maintainer IDs',
        '',
        `Resolved **${sorted.length}** maintainer ID${sorted.length === 1 ? '' : 's'} via the LaunchDarkly /members ` +
          `endpoint. Use this table to read 'Dropped maintainer metadata' below — each \`maintainerId\` there maps to the ` +
          `email here.`,
        '',
        '| maintainerId | email |',
        '| --- | --- |',
        ...rows,
      ].join('\n'),
    )
  }

  if (sections.length === 0) return `${header}\n\n${NONE}`
  return [header, '', ...sections].join('\n\n')
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

const renderKeyRewrites = (rewrites: KeyRewrite[] | null | undefined): null | string => {
  if (!rewrites || rewrites.length === 0) return null
  const lines: string[] = [
    '## Rewritten keys (ACTION REQUIRED)',
    '',
    `The migrator rewrote **${rewrites.length}** source key(s) that Quonfig does not allow verbatim (Policy A: letters, numbers, \`.\`, \`-\`, \`_\`; 200 chars max; no leading dot) or that collided with another key. **The Quonfig key is what your SDK code must now look up** — update any \`get("...")\` / \`variation("...")\` call that used the old name. A machine-readable map is also written to \`.qf/key-map.json\`.`,
    '',
    '| Source key | Quonfig key | Why |',
    '| --- | --- | --- |',
  ]
  const sorted = [...rewrites].sort((a, b) => a.source.localeCompare(b.source))
  for (const r of sorted) {
    lines.push(`| \`${r.source}\` | \`${r.final}\` | ${r.reasons.join('; ')} |`)
  }

  return lines.join('\n')
}

const FLAGSMITH_ENV_BUCKET_LABEL: Record<string, string> = {
  '_all-envs': 'Override rows (all environments)',
  '_cross-env': 'Cross-environment value-type divergence (no single env owns this)',
}

const renderCoercedSentinels = (coerced: CoercedSentinelSummary | null | undefined, source: string): null | string => {
  if (!coerced || coerced.total === 0) return null
  const envIds = Object.keys(coerced.byEnv).sort()
  const intro =
    source === 'flagsmith'
      ? `Coerced **${coerced.total}** rule value(s) from Flagsmith's runtime semantics into a concrete served value. ` +
        `Two flavors are bucketed here:\n\n` +
        `1. **D-F1: \`enabled=false\` on non-boolean features.** Flagsmith would have ignored the stored value and ` +
        `served your code's hardcoded default. Quonfig always serves a value, so the migrator emits the stored ` +
        `\`feature_state_value\` and surfaces every affected flag below.\n` +
        `2. **D-F5: cross-environment value-type divergence.** Flagsmith allowed the same flag to be a string in one ` +
        `env and an int in another; Quonfig requires one \`valueType\` per flag. The migrator coerced to \`string\`.\n\n` +
        `Review each entry below and set a real default in the source system if the value is wrong.`
      : `Coerced **${coerced.total}** rule value(s) from Launch's "no value set yet" sentinel ` +
        `({type:"string", value:""}) to the typed default for the surrounding config. The qfg-verify hook would ` +
        `otherwise reject these as type-mismatches and fail-stop the entire push. Affected envs: ` +
        `**${envIds.length}**. Review each and set a real default in the source system if needed.`
  const lines: string[] = ['## Coerced sentinel rule values', '', intro]
  for (const envId of envIds) {
    const perFlag = coerced.byEnv[envId]
    const totalForEnv = Object.values(perFlag).reduce((s, n) => s + n, 0)
    const flagCount = Object.keys(perFlag).length
    const heading = FLAGSMITH_ENV_BUCKET_LABEL[envId] ?? `env-${envId}`
    lines.push('', `### ${heading} — ${totalForEnv} coerced from ${flagCount} config(s)`, '')
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

/**
 * Human-readable headings for the non-rollout conversion-note categories.
 * `skipped-config` is intentionally absent — it has its own dedicated section
 * (`renderSkippedConfigs`). `rebucketed-rollout` is absent because it gets its
 * own top-level section (`renderRebucketedRollouts`) — plan §5.4 requires it
 * be impossible to miss.
 */
const CONVERSION_NOTE_HEADINGS: Record<
  Exclude<ConversionNoteCategory, 'rebucketed-rollout' | 'skipped-config'>,
  string
> = {
  'ai-config-skipped': 'AI Configs skipped (out of v1 scope)',
  'cross-env-value-type-coerced': 'Cross-environment value-type coerced to string',
  'dropped-custom-properties': 'Dropped custom properties',
  'dropped-experiment-metadata': 'Dropped experiment metadata',
  'dropped-maintainer': 'Dropped maintainer metadata',
  'dropped-mobile-key-now-server-only': 'Dropped mobile-key availability (now server-only)',
  'dropped-mobile-key-still-visible': 'Dropped mobile-key availability (still client-visible)',
  'dropped-prerequisite': 'Dropped prerequisites',
  'dropped-private-attribute': 'Dropped private attributes',
  'enabled-false-non-boolean': 'enabled=false on non-boolean features',
  'identity-override-as-rule': 'Identity overrides converted to leading rules',
  'identity-traits-referenced': 'Identity traits referenced by segment rules',
  'individual-target-as-rule': 'Individual targets converted to rules',
  'skipped-rule': 'Skipped rules (unsupported operators)',
  'unexportable-segment-membership': 'Unexportable segment membership',
}

/**
 * "Before you cut over" — top-of-document TL;DR (qfg-e8md). Rolls up the
 * 1-N signal categories that need a human decision this run, and an optional
 * "You can ignore" line for the high-volume informational categories.
 *
 * Suppressed entirely when no signal categories have entries — there is
 * nothing for a human to act on.
 */
type SignalCategory =
  | 'dropped-mobile-key-now-server-only'
  | 'dropped-prerequisite'
  | 'rebucketed-rollout'
  | 'skipped-rule'
  | 'unexportable-segment-membership'

interface SignalSpec {
  /** Renders the headline bullet given count and example keys. */
  render: (count: number, exampleKeys: string[]) => string
}

const SIGNAL_SPECS: Record<SignalCategory, SignalSpec> = {
  'dropped-mobile-key-now-server-only': {
    render: (count, keys) =>
      `**${count} flag${count === 1 ? '' : 's'} ${count === 1 ? 'will' : 'will'} stop reaching mobile clients** ` +
      `(${keys.map((k) => `\`${k}\``).join(', ')}). LaunchDarkly had \`usingMobileKey:true\` with ` +
      `\`usingEnvironmentId:false\` — these were mobile-only and won't be visible to mobile SDKs post-migration. ` +
      `Rebuild client-side access by hand before cutover.`,
  },
  'dropped-prerequisite': {
    render: (count, keys) =>
      `**${count} flag${count === 1 ? '' : 's'} lost cross-flag dependencies** (${keys.map((k) => `\`${k}\``).join(', ')}). ` +
      `The Quonfig copy now serves its variations independently of its parent flag. ` +
      `Review §'Dropped prerequisites' below.`,
  },
  'rebucketed-rollout': {
    render: (count) =>
      `**${count} flag${count === 1 ? '' : 's'} will re-bucket users.** Coordinate comms or drain affected ` +
      `rollouts — see 'Users will be re-bucketed' below.`,
  },
  'skipped-rule': {
    render: (count, keys) =>
      `**${count} flag${count === 1 ? '' : 's'} had rules skipped** (${keys.map((k) => `\`${k}\``).join(', ')}) — ` +
      `a clause used an unsupported operator. Rebuild the rule by hand before cutover.`,
  },
  'unexportable-segment-membership': {
    render: (count, keys) =>
      `**${count} segment${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} missing membership** (${keys
        .map((k) => `\`${k}\``)
        .join(', ')}). Re-author or sync from your IdP before cutover.`,
  },
}

const SIGNAL_ORDER: SignalCategory[] = [
  'dropped-mobile-key-now-server-only',
  'dropped-prerequisite',
  'rebucketed-rollout',
  'unexportable-segment-membership',
  'skipped-rule',
]

const MAX_EXAMPLE_KEYS = 3

const groupKeysByCategory = (notes: ConversionNote[]): Map<string, string[]> => {
  const map = new Map<string, string[]>()
  for (const note of notes) {
    const list = map.get(note.category) ?? []
    list.push(note.key)
    map.set(note.category, list)
  }

  return map
}

const renderBeforeYouCutOver = (notes: ConversionNote[] | undefined): null | string => {
  if (!notes || notes.length === 0) return null
  const byCategory = groupKeysByCategory(notes)

  const items: string[] = []
  for (const category of SIGNAL_ORDER) {
    const keys = byCategory.get(category)
    if (!keys || keys.length === 0) continue
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b))
    const example = sortedKeys.slice(0, MAX_EXAMPLE_KEYS)
    const truncated = sortedKeys.length > MAX_EXAMPLE_KEYS ? [...example, '…'] : example
    items.push(SIGNAL_SPECS[category].render(sortedKeys.length, truncated))
  }

  if (items.length === 0) return null

  const lines: string[] = [
    '## Before you cut over',
    '',
    `${items.length} thing${items.length === 1 ? ' needs' : 's need'} a human decision before flipping the SDK:`,
    '',
  ]
  items.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item}`)
  })

  const ignoreParts: string[] = []
  const maintainerCount = byCategory.get('dropped-maintainer')?.length ?? 0
  if (maintainerCount > 0) {
    ignoreParts.push(`dropped maintainer metadata (${maintainerCount} entries — git authorship replaces it)`)
  }

  const mobileKeyCount = byCategory.get('dropped-mobile-key-still-visible')?.length ?? 0
  if (mobileKeyCount > 0) {
    ignoreParts.push(
      `dropped mobile-key availability (${mobileKeyCount} entries — all still client-visible via usingEnvironmentId)`,
    )
  }

  if (ignoreParts.length > 0) {
    lines.push('', `You can ignore: ${ignoreParts.join(', ')}.`)
  }

  return lines.join('\n')
}

const renderRebucketedRollouts = (notes: ConversionNote[] | undefined, source: string): null | string => {
  const rollouts = (notes ?? []).filter((n) => n.category === 'rebucketed-rollout')
  if (rollouts.length === 0) return null
  const sourceLabel = source === 'flagsmith' ? 'Flagsmith' : source === 'launchdarkly' ? 'LaunchDarkly' : source
  const lines: string[] = [
    '## Users will be re-bucketed',
    '',
    `**${rollouts.length}** flag(s)/segment(s) use a percentage rollout. ${sourceLabel} and Quonfig hash buckets ` +
      `differently, so which users land in which bucket *will change* after migration — the rollout percentage is ` +
      `preserved, but individual user assignments are not. Review these before cutover so the re-bucketing is not a surprise:`,
    '',
  ]
  const sorted = [...rollouts].sort((a, b) => a.key.localeCompare(b.key))
  for (const note of sorted) {
    lines.push(`- \`${note.key}\` — ${note.detail}`)
  }

  return lines.join('\n')
}

/**
 * Categories that are pure informational noise (drowned out the signal in the
 * 172-note LD migration report — see qfg-ve5w). Render as a 1-line rollup +
 * collapsible `<details>` block instead of N top-level bullets.
 */
const COLLAPSED_CATEGORIES: Partial<Record<ConversionNoteCategory, (count: number) => string>> = {
  'dropped-maintainer': (count) =>
    `${count} flag${count === 1 ? '' : 's'} had a maintainer ID dropped. Intentional — Quonfig authorship lives in ` +
    `git history. No action required.`,
  'dropped-mobile-key-still-visible': (count) =>
    `${count} flag${count === 1 ? '' : 's'} had \`usingMobileKey:true\` collapsed into the single \`sendToClientSdk\` ` +
    `boolean. Each flag is still client-visible via \`usingEnvironmentId\`. No action required.`,
}

/**
 * Render the `dropped-prerequisite` subsection (qfg-nb4n): one multi-line entry
 * per child flag with nested parent bullets naming each variation index, plus
 * a trailing inverted view that lists each orphaned parent and its downstream
 * consumers. Returns the rendered lines (without the `### …` header — that is
 * pushed by the caller so the section grouping stays consistent).
 */
const renderDroppedPrerequisiteBody = (notes: ConversionNote[]): string[] => {
  const sorted = [...notes].sort((a, b) => a.key.localeCompare(b.key))
  const lines: string[] = []

  // Forward view: child flag → parents.
  for (const note of sorted) {
    const edges = note.prerequisites
    if (!edges || edges.length === 0) {
      // Backward-compat fallback when a future caller forgets the structured payload.
      lines.push(`- \`${note.key}\` — ${note.detail}`)
      continue
    }

    lines.push(
      `- \`${note.key}\` evaluated independently of its ${edges.length} parent${edges.length === 1 ? '' : 's'}:`,
    )
    for (const edge of edges) {
      lines.push(`  - was gated on \`${edge.parentKey}\` = variation ${edge.variation}`)
    }

    lines.push('  To preserve the gate, add a leading rule matching the same parent state, or wrap reads in app code.')
  }

  // Inverted view: parent → children that depended on it.
  const parentToChildren = new Map<string, Set<string>>()
  for (const note of sorted) {
    for (const edge of note.prerequisites ?? []) {
      const set = parentToChildren.get(edge.parentKey) ?? new Set<string>()
      set.add(note.key)
      parentToChildren.set(edge.parentKey, set)
    }
  }

  if (parentToChildren.size > 0) {
    lines.push('', '#### Orphaned parent flags (inverted view)', '')
    const parents = [...parentToChildren.keys()].sort((a, b) => a.localeCompare(b))
    for (const parent of parents) {
      const children = [...(parentToChildren.get(parent) ?? [])].sort((a, b) => a.localeCompare(b))
      const childList = children.map((c) => `\`${c}\``).join(', ')
      lines.push(
        `- **\`${parent}\`** is now an orphaned dependency. Downstream flags that depended on it: ${childList}.`,
      )
    }
  }

  return lines
}

/**
 * qfg-l8uz: substitute every `<hex maintainerId>` in a dropped-maintainer
 * detail with `<id> (<email>)` so the per-flag rollup reads as a human label
 * instead of an opaque hex string. No-op when the map is empty/missing or the
 * ID isn't in it (team-key drops, partial member visibility) — the unsubstituted
 * line is still informative.
 */
const decorateMaintainerDetail = (detail: string, maintainerMap?: null | Record<string, string>): string => {
  if (!maintainerMap) return detail
  return detail.replaceAll(/[\da-f]{24}/g, (match) => {
    const email = maintainerMap[match]
    return email ? `${match} (${email})` : match
  })
}

const renderConversionNotes = (
  notes: ConversionNote[] | undefined,
  maintainerMap?: null | Record<string, string>,
): null | string => {
  // `skipped-config` (own section) and `rebucketed-rollout` (own section) are
  // rendered elsewhere — everything else is grouped by category here.
  const grouped = (notes ?? []).filter((n) => n.category !== 'rebucketed-rollout' && n.category !== 'skipped-config')
  if (grouped.length === 0) return null
  const lines: string[] = [
    '## Conversion notes',
    '',
    `**${grouped.length}** note(s) where the converter could not represent a source concept exactly. Nothing was ` +
      `silently dropped — each entry below names the exact flag/segment and what was lost so you can rebuild it by hand if needed.`,
  ]
  const categoriesInOrder = Object.keys(CONVERSION_NOTE_HEADINGS) as Array<keyof typeof CONVERSION_NOTE_HEADINGS>
  for (const category of categoriesInOrder) {
    const forCategory = grouped.filter((n) => n.category === category)
    if (forCategory.length === 0) continue
    lines.push('', `### ${CONVERSION_NOTE_HEADINGS[category]}`, '')
    const sorted = [...forCategory].sort((a, b) => a.key.localeCompare(b.key))
    const rollup = COLLAPSED_CATEGORIES[category]
    if (rollup) {
      lines.push(rollup(sorted.length), '', '<details><summary>Per-flag list</summary>', '')
      for (const note of sorted) {
        const detail =
          category === 'dropped-maintainer' ? decorateMaintainerDetail(note.detail, maintainerMap) : note.detail
        lines.push(`- \`${note.key}\` — ${detail}`)
      }

      lines.push('', '</details>')
      continue
    }

    if (category === 'dropped-prerequisite') {
      lines.push(...renderDroppedPrerequisiteBody(sorted))
      continue
    }

    for (const note of sorted) {
      lines.push(`- \`${note.key}\` — ${note.detail}`)
    }
  }

  return lines.join('\n')
}

/**
 * Maps each lossy conversion-note category to a Follow-up checklist bucket plus
 * a 1-line remediation hint. Categories not listed here (or `skipped-config` /
 * housekeeping categories like `dropped-maintainer`) are intentionally not
 * surfaced as checklist items — they get their own dedicated report sections
 * or are pure-metadata losses that don't require human follow-up.
 */
const FOLLOW_UP_BUCKETS: Partial<
  Record<ConversionNoteCategory, {bucket: 'mustFixBeforeCutover' | 'reviewPostCutover'; hint: (key: string) => string}>
> = {
  'dropped-mobile-key-now-server-only': {
    bucket: 'mustFixBeforeCutover',
    hint: (key) =>
      `\`${key}\` — flag was mobile-only in LaunchDarkly (usingMobileKey:true, usingEnvironmentId:false) and will not reach mobile SDKs after migration; restore client-side access by hand.`,
  },
  'dropped-prerequisite': {
    bucket: 'mustFixBeforeCutover',
    hint: (key) =>
      `\`${key}\` — restore the dropped prerequisite gate manually; Quonfig v1 has no cross-flag dependency operator.`,
  },
  'individual-target-as-rule': {
    bucket: 'reviewPostCutover',
    hint: (key) =>
      `\`${key}\` — individual user targets are now a leading rule; the LaunchDarkly targets pane affordance is gone.`,
  },
  'rebucketed-rollout': {
    bucket: 'reviewPostCutover',
    hint: (key) => `\`${key}\` — percentage rollout will re-bucket users post-migration; communicate before cutover.`,
  },
  'skipped-rule': {
    bucket: 'mustFixBeforeCutover',
    hint: (key) => `\`${key}\` — a rule clause used an unsupported operator and was skipped; rebuild the rule by hand.`,
  },
  'unexportable-segment-membership': {
    bucket: 'mustFixBeforeCutover',
    hint: (key) =>
      `\`${key}\` — segment shell migrated but membership is empty (LD big/synced segment); repopulate members before cutover.`,
  },
}

/**
 * Folds conversion notes into a followUp checklist. De-duplicates by hint
 * string so a flag with two dropped prerequisites doesn't produce two
 * identical checkbox lines.
 */
export const deriveFollowUpFromConversionNotes = (
  base: FollowUpChecklist,
  notes: ConversionNote[] | undefined,
): FollowUpChecklist => {
  const mustFix = new Set(base.mustFixBeforeCutover)
  const review = new Set(base.reviewPostCutover)
  for (const note of notes ?? []) {
    const mapping = FOLLOW_UP_BUCKETS[note.category]
    if (!mapping) continue
    const line = mapping.hint(note.key)
    if (mapping.bucket === 'mustFixBeforeCutover') mustFix.add(line)
    else review.add(line)
  }

  return {mustFixBeforeCutover: [...mustFix], reviewPostCutover: [...review]}
}

/**
 * Static, content-stable appendix describing v1 behavioral gaps between
 * LaunchDarkly and Quonfig (plan §5.4 / qfg-ox7m). Documentation, not data —
 * does not vary across runs. Rendered only when source === 'launchdarkly'.
 */
const LAUNCHDARKLY_BEHAVIORAL_DIFFERENCES_APPENDIX = [
  '## Behavioral differences post-cutover (independent of this import)',
  '',
  '- LaunchDarkly evaluates targets/contextTargets *before* rules. Quonfig has no',
  '  individual-target primitive; user/context targets are now a leading PROP_IS_ONE_OF',
  '  rule. Adding/removing individuals is now a config edit (qfg set / web UI), not a',
  '  separate targeting UI pane.',
  "- LaunchDarkly's 'off' toggle disappears. A flag is on iff at least one rule",
  '  matches; there is no global kill-switch unless you author one as a top rule.',
  '- offVariation does not exist in Quonfig. The off-state behavior of any flag',
  '  that was on=false in LD has been baked into a single ALWAYS_TRUE rule serving',
  '  that variation.',
  '- Mobile SDK keys: LaunchDarkly distinguished mobile-key vs environment-id',
  '  availability. Quonfig has one sendToClientSdk bool — your iOS/Android and',
  '  browser-JS SDKs now share the same client-visibility setting.',
  '- Maintainer is no longer a field on flags. `git log path/to/flag.json` is the',
  '  new source of truth.',
].join('\n')

/**
 * Flagsmith-specific behavioral-differences appendix (plan §5.5). Same shape
 * as the LD version above — static documentation about gaps a customer reading
 * MIGRATION_REPORT.md should know about independently of their specific data.
 */
const FLAGSMITH_BEHAVIORAL_DIFFERENCES_APPENDIX = [
  '## Behavioral differences post-cutover (independent of this import)',
  '',
  '- `enabled=false` semantics differ. Flagsmith ignores `feature_state_value` when',
  "  `enabled=false` and the SDK serves your code's hardcoded default. Quonfig always",
  '  serves the configured value. For boolean features the migrator emits `false`; for',
  '  non-boolean features it emits the stored `feature_state_value` and surfaces every',
  '  affected flag under "Coerced sentinel rule values" above. Review each before',
  '  cutover — Flagsmith\'s "off" behavior does NOT round-trip.',
  '- Flagsmith has no individual-target primitive in Quonfig v1. Identity overrides',
  '  are emitted as leading `PROP_IS_ONE_OF` rules on `user.key`. Adding/removing an',
  '  identity is now a config edit (qfg set / web UI), not a per-identity row.',
  '- Identity traits are runtime context Flagsmith infers from the trait directory.',
  '  Quonfig has no server-side trait store — your SDK callers must send every trait',
  '  attribute referenced by a segment rule on the eval context. See "Identity traits',
  '  referenced by segment rules" above for the exhaustive list.',
  '- Multivariate bucketing salts differ between Flagsmith and Quonfig. The percentage',
  '  allocation is preserved, but identity → variation assignments WILL change. See',
  '  "Users will be re-bucketed" above.',
  '- MODULO and PERCENTAGE_SPLIT segment-condition operators have no Quonfig equivalent.',
  '  Rules using them were dropped with `skipped-rule` notes; rebuild by hand if you',
  '  need the segmentation.',
  '- Segment rule combinators `type=ANY` and `type=NONE` (within-rule OR / NAND) have',
  '  no Quonfig equivalent — Quonfig criteria within a single rule are AND-only. Those',
  '  rules were dropped with `skipped-rule` notes.',
  "- `:semver`-suffixed values are mapped to Quonfig's `PROP_SEMVER_*` operators.",
  '  Inclusive variants (GTE/LTE) have no semver equivalent and were dropped.',
  '- Soft-deleted features in Flagsmith are functionally hard-deleted from the public',
  '  API (404 on GET, absent from list responses). The migrator cannot enumerate them;',
  '  any features deleted before this snapshot was taken are simply not present in the',
  '  Quonfig workspace.',
  '- Feature owners, project metadata, change requests, and scheduled changes are out',
  '  of v1 scope. None round-trip into Quonfig.',
].join('\n')

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
  )

  const beforeYouCutOver = renderBeforeYouCutOver(data.conversionNotes)
  if (beforeYouCutOver !== null) sections.push(beforeYouCutOver)

  sections.push(
    renderCounts(data.counts),
    renderCleanMappings(data.cleanMappings),
    renderLossyMappings(data.lossyMappings),
    renderUnsupported(data.unsupportedFeatures),
    renderEnvironmentMap(data.environmentMap),
    renderIdentifierMap(data.identifierMap, data.maintainerMap),
  )

  const dropped = renderDroppedOverrides(data.droppedOverrides)
  if (dropped !== null) sections.push(dropped)

  const keyRewrites = renderKeyRewrites(data.keyRewrites)
  if (keyRewrites !== null) sections.push(keyRewrites)

  const resolved = renderDuplicateResolutions(data.duplicateResolutions)
  if (resolved !== null) sections.push(resolved)

  const skipped = renderSkippedConfigs(data.skippedConfigs)
  if (skipped !== null) sections.push(skipped)

  const coerced = renderCoercedSentinels(data.coercedSentinels, data.source)
  if (coerced !== null) sections.push(coerced)

  const rebucketed = renderRebucketedRollouts(data.conversionNotes, data.source)
  if (rebucketed !== null) sections.push(rebucketed)

  const conversionNotes = renderConversionNotes(data.conversionNotes, data.maintainerMap)
  if (conversionNotes !== null) sections.push(conversionNotes)

  sections.push(renderFollowUp(data.followUp))

  if (data.source === 'launchdarkly') {
    sections.push(LAUNCHDARKLY_BEHAVIORAL_DIFFERENCES_APPENDIX)
  }

  if (data.source === 'flagsmith') {
    sections.push(FLAGSMITH_BEHAVIORAL_DIFFERENCES_APPENDIX)
  }

  return sections.join('\n\n') + '\n'
}

/**
 * Path of the migration report. It lives inside the `.qf/` bookkeeping
 * directory (next to `import-state.json`), NOT the workspace root (qfg-a631).
 *
 * `qfg push` mirrors every non-dotfile on disk and the server's
 * config-path-allowlist only permits `configs/`, `feature-flags/`, etc. plus
 * `quonfig.json`/`README.md`. A root-level `MIGRATION_REPORT.md` got swept
 * into the push and rejected ("Path not allowed by push allow-list"). Keeping
 * it under the `.qf/` dotdir means the existing dotfile/dotdir skip in
 * `bare-path-diff.ts` excludes it — no server change needed.
 */
export const migrationReportPath = (outputDir: string): string => path.join(outputDir, '.qf', 'MIGRATION_REPORT.md')

/**
 * qfg-6na9.3: machine-readable `source -> quonfig` key map, next to the report
 * under `.qf/` (excluded from the push, like MIGRATION_REPORT.md). Lets a
 * customer script the SDK-lookup updates for renamed keys.
 */
export const keyMapPath = (outputDir: string): string => path.join(outputDir, '.qf', 'key-map.json')

export const writeMigrationReport = (outputDir: string, data: MigrationReportData): string => {
  const filePath = migrationReportPath(outputDir)
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(filePath, buildMigrationReport(data), 'utf8')

  if (data.keyRewrites && data.keyRewrites.length > 0) {
    fs.writeFileSync(
      keyMapPath(outputDir),
      JSON.stringify(
        {
          rewrites: data.keyRewrites.map((r) => ({final: r.final, reasons: r.reasons, source: r.source})),
          source: data.source,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }

  return filePath
}
