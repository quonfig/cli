import {Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {readImportState} from '../../migrate/import-state.js'

interface WorkspaceCounts {
  environments: number
  flags: number
  segments: number
}

const FLAGS_DIR = 'feature-flags'
const SEGMENTS_DIR = 'segments'
const WORKSPACE_FILE = 'quonfig.json'

const NO_STATE_MESSAGE = 'No migration state found. Run qfg migrate --from <source> first.'

function countJsonFiles(dir: string): number {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).length
}

function countEnvironments(dir: string): number {
  const file = path.join(dir, WORKSPACE_FILE)
  if (!fs.existsSync(file)) return 0
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      environments?: unknown
    }
    return Array.isArray(parsed.environments) ? parsed.environments.length : 0
  } catch {
    return 0
  }
}

function workspaceCounts(dir: string): WorkspaceCounts {
  return {
    environments: countEnvironments(dir),
    flags: countJsonFiles(path.join(dir, FLAGS_DIR)),
    segments: countJsonFiles(path.join(dir, SEGMENTS_DIR)),
  }
}

function toIsoTimestamp(value: number | string | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function nextHint(source: string, counts: WorkspaceCounts): string {
  if (counts.flags === 0 && counts.segments === 0) {
    return `Run \`qfg migrate --from ${source}\` to import flags and segments.`
  }

  return `Run \`qfg migrate my-code --from ${source}\` to update your SDK call sites, or re-run \`qfg migrate --from ${source}\` to pick up changes.`
}

function formatHuman(payload: {
  counts: WorkspaceCounts
  dir: string
  lastProcessedAt: number | string | null
  lastProcessedAtIso: string | null
  next: string
  source: string
  sourceWorkspaceId: string | null
}): string {
  const lines: string[] = []
  lines.push(
    `Source:            ${payload.source}`,
    `Source workspace:  ${payload.sourceWorkspaceId ?? '(not recorded)'}`,
    `Last processed at: ${payload.lastProcessedAtIso ?? '(not recorded)'}`,
    `Workspace dir:     ${payload.dir}`,
    '',
    'Counts:',
    `  Flags:         ${payload.counts.flags}`,
    `  Segments:      ${payload.counts.segments}`,
    `  Environments:  ${payload.counts.environments}`,
    '',
    `Next: ${payload.next}`,
  )
  return lines.join('\n')
}

export default class MigrateStatus extends BaseCommand {
  static description =
    'Show the status of a workspace migrated with `qfg migrate`. Reads .qf/import-state.json and summarizes source, counts, and next steps.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dir ./my-workspace',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    dir: Flags.string({
      default: '.',
      description: 'Workspace directory to inspect',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(MigrateStatus)
    const dir = path.resolve(flags.dir)
    const state = readImportState(dir)

    if (!state) {
      const payload = {
        dir,
        found: false as const,
        message: NO_STATE_MESSAGE,
      }
      if (this.jsonEnabled()) return payload
      this.log(NO_STATE_MESSAGE)
      return payload
    }

    const counts = workspaceCounts(dir)
    const lastProcessedAtIso = toIsoTimestamp(state.lastProcessedAt)
    const next = nextHint(state.source, counts)

    const payload = {
      counts,
      dir,
      found: true as const,
      lastProcessedAt: state.lastProcessedAt ?? null,
      lastProcessedAtIso,
      next,
      source: state.source,
      sourceWorkspaceId: state.sourceWorkspaceId ?? null,
    }

    if (this.jsonEnabled()) return payload

    this.log(formatHuman(payload))
    return payload
  }
}
