import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {SKILL_FILES, SKILL_NAME, SKILL_VERSION} from './skill-bundle.generated.js'

/**
 * Install the vendored Quonfig agent skill into an application repo.
 *
 * The skill text is embedded at build time from github.com/quonfig/skills
 * (see scripts/sync-agent-skill.mjs) — nothing is fetched at runtime.
 *
 * Ownership: a `.quonfig-skill.json` manifest next to SKILL.md records the
 * sha256 of every file as we wrote it. On re-run, a file whose bytes still
 * match the manifest is ours to upgrade; a file that differs from both the
 * manifest and the new content was edited by the customer and is only
 * overwritten with `force`.
 */

export const MANIFEST_FILE = '.quonfig-skill.json'
export const DEFAULT_SKILLS_DIR = path.join('.claude', 'skills')

export type FileStatus = 'conflict' | 'created' | 'removed' | 'unchanged' | 'updated'

export type InstallPlan = {
  conflicts: string[]
  files: {content?: string; path: string; status: FileStatus}[]
  skillDir: string
  version: string
}

type Manifest = {files: Record<string, string>; skill: string; version: string}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function readManifest(skillDir: string): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(skillDir, MANIFEST_FILE), 'utf8')) as Manifest
  } catch {
    return undefined
  }
}

export function planInstall({force, skillsDir}: {force: boolean; skillsDir: string}): InstallPlan {
  const skillDir = path.join(skillsDir, SKILL_NAME)
  const manifest = readManifest(skillDir)
  const owned = manifest?.files ?? {}
  const files: InstallPlan['files'] = []
  const conflicts: string[] = []

  for (const file of SKILL_FILES) {
    const target = path.join(skillDir, file.path)
    if (!fs.existsSync(target)) {
      files.push({content: file.content, path: file.path, status: 'created'})
      continue
    }

    const current = fs.readFileSync(target, 'utf8')
    if (current === file.content) {
      files.push({path: file.path, status: 'unchanged'})
      continue
    }

    const ours = owned[file.path] !== undefined && owned[file.path] === sha256(current)
    if (ours || force) {
      files.push({content: file.content, path: file.path, status: 'updated'})
    } else {
      files.push({path: file.path, status: 'conflict'})
      conflicts.push(file.path)
    }
  }

  // Files an earlier version installed that this version no longer ships:
  // remove them only if they are still byte-for-byte what we wrote.
  const shipped = new Set(SKILL_FILES.map((f) => f.path))
  for (const [rel, hash] of Object.entries(owned)) {
    if (shipped.has(rel)) continue
    const target = path.join(skillDir, rel)
    if (fs.existsSync(target) && sha256(fs.readFileSync(target, 'utf8')) === hash) {
      files.push({path: rel, status: 'removed'})
    }
  }

  return {conflicts, files, skillDir, version: SKILL_VERSION}
}

export function executeInstall(plan: InstallPlan): void {
  for (const file of plan.files) {
    const target = path.join(plan.skillDir, file.path)
    if (file.status === 'created' || file.status === 'updated') {
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, file.content!)
    } else if (file.status === 'removed') {
      fs.rmSync(target)
    }
  }

  const manifest: Manifest = {
    files: Object.fromEntries(SKILL_FILES.map((f) => [f.path, sha256(f.content)])),
    skill: SKILL_NAME,
    version: SKILL_VERSION,
  }
  fs.mkdirSync(plan.skillDir, {recursive: true})
  fs.writeFileSync(path.join(plan.skillDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
}

/** The one line an AGENTS.md needs so non-Claude agents (Codex, Cursor, ...) find the skill. */
export function pointerLine(skillDir: string): string {
  const rel = skillDir.split(path.sep).join('/')
  return `- **Quonfig (feature flags, config, log levels):** before adding, reading, or changing a flag or config, read \`${rel}/SKILL.md\` and follow it. (Installed by \`qfg agent install-skill\`.)`
}

export type PointerResult = 'added' | 'present'

function agentsMdState(repoDir: string, skillDir: string): {existing: string; marker: string; path: string} {
  const agentsMd = path.join(repoDir, 'AGENTS.md')
  const marker = `${path.relative(repoDir, skillDir).split(path.sep).join('/')}/SKILL.md`
  const existing = fs.existsSync(agentsMd) ? fs.readFileSync(agentsMd, 'utf8') : ''
  return {existing, marker, path: agentsMd}
}

/** True when ./AGENTS.md already points at the installed skill. */
export function hasPointer(repoDir: string, skillDir: string): boolean {
  const {existing, marker} = agentsMdState(repoDir, skillDir)
  return existing.includes(marker)
}

/** Append the pointer to AGENTS.md (creating it if needed). Idempotent. */
export function addPointer(repoDir: string, skillDir: string): PointerResult {
  const {existing, marker, path: agentsMd} = agentsMdState(repoDir, skillDir)
  if (existing.includes(marker)) return 'present'

  const prefix = existing === '' ? '# Agent Instructions\n\n' : existing.endsWith('\n') ? '\n' : '\n\n'
  fs.writeFileSync(agentsMd, existing + prefix + pointerLine(path.relative(repoDir, skillDir)) + '\n')
  return 'added'
}
