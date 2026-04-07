/**
 * Core logic for `qfg init`.
 *
 * Uses a plan/execute pattern so --dry-run can show what *would* happen
 * without writing anything.
 */

import {execSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {SAMPLE_FILES} from './samples.js'
import {storedConfigJsonSchema} from './schema.js'
import {
  PRE_COMMIT_MARKER,
  agentsMdTemplate,
  claudeMdTemplate,
  preCommitHookContent,
  readmeTemplate,
} from './templates.js'

// ── Public types ───────────────────────────────────────────────────────

export interface InitOptions {
  dir: string
  /** true = force include samples, false = force skip, undefined = auto-detect */
  samples: boolean | undefined
  dryRun: boolean
}

export type ActionKind =
  | 'git-init'
  | 'create-dir'
  | 'write-file'
  | 'skip-file'
  | 'create-hook'
  | 'update-hook'
  | 'skip-hook'

export interface InitAction {
  kind: ActionKind
  path: string
  description: string
}

export interface InitPlan {
  actions: InitAction[]
  isFirstTime: boolean
  samplesIncluded: boolean
}

// ── Directories that define a workspace ────────────────────────────────

const WORKSPACE_DIRS = [
  'configs',
  'feature-flags',
  'segments',
  'log-levels',
  'schemas',
]

// ── Plan ───────────────────────────────────────────────────────────────

export function planInit(options: InitOptions): InitPlan {
  const {dir} = options
  const actions: InitAction[] = []

  // Detect first-time vs update: do any workspace dirs already exist?
  const isFirstTime = !WORKSPACE_DIRS.some((d) => fs.existsSync(path.join(dir, d)))

  // Resolve samples flag: first-time → default on, update → default off
  const includeSamples = options.samples ?? isFirstTime

  // 0. Ensure it's a git repo
  const gitDir = path.join(dir, '.git')
  const needsGitInit = !fs.existsSync(gitDir)
  if (needsGitInit) {
    actions.push({kind: 'git-init', path: '.git', description: 'Initialize git repository'})
  }

  // 1. Ensure directories exist
  for (const d of WORKSPACE_DIRS) {
    const dirPath = path.join(dir, d)
    if (fs.existsSync(dirPath)) {
      // directory already exists, nothing to do
    } else {
      actions.push({kind: 'create-dir', path: d, description: `Create ${d}/`})
    }
  }

  // 2. Managed files — always overwrite
  const managedFiles: Array<{content: string; file: string}> = [
    {file: 'quonfig.schema.json', content: JSON.stringify(storedConfigJsonSchema(), null, 2) + '\n'},
    {file: 'README.md', content: readmeTemplate()},
    {file: 'CLAUDE.md', content: claudeMdTemplate()},
    {file: 'AGENTS.md', content: agentsMdTemplate()},
  ]

  for (const {file, content: _content} of managedFiles) {
    const filePath = path.join(dir, file)
    const verb = fs.existsSync(filePath) ? 'Update' : 'Create'
    actions.push({kind: 'write-file', path: file, description: `${verb} ${file}`})
  }

  // 3. quonfig.json — create if missing
  const envsPath = path.join(dir, 'quonfig.json')
  if (fs.existsSync(envsPath)) {
    // leave it alone
  } else {
    actions.push({kind: 'write-file', path: 'quonfig.json', description: 'Create quonfig.json'})
  }

  // 4. Sample data
  if (includeSamples) {
    for (const sample of SAMPLE_FILES) {
      const samplePath = path.join(dir, sample.path)
      if (fs.existsSync(samplePath)) {
        actions.push({kind: 'skip-file', path: sample.path, description: `Skip ${sample.path} (already exists)`})
      } else {
        actions.push({kind: 'write-file', path: sample.path, description: `Create ${sample.path}`})
      }
    }
  }

  // 5. Git pre-commit hook (always runs — git repo guaranteed by step 0)
  if (needsGitInit) {
    // Fresh git init — hook will be created
    actions.push({kind: 'create-hook', path: '.git/hooks/pre-commit', description: 'Install pre-commit hook (qfg verify)'})
  } else {
    const hooksDir = path.join(gitDir, 'hooks')
    const hookPath = path.join(hooksDir, 'pre-commit')
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf-8')
      if (existing.includes(PRE_COMMIT_MARKER)) {
        actions.push({kind: 'skip-hook', path: '.git/hooks/pre-commit', description: 'Pre-commit hook already installed'})
      } else if (existing.includes('qfg verify')) {
        actions.push({kind: 'skip-hook', path: '.git/hooks/pre-commit', description: 'Pre-commit hook already runs qfg verify'})
      } else {
        actions.push({kind: 'update-hook', path: '.git/hooks/pre-commit', description: 'Append qfg verify to existing pre-commit hook'})
      }
    } else {
      actions.push({kind: 'create-hook', path: '.git/hooks/pre-commit', description: 'Install pre-commit hook (qfg verify)'})
    }
  }

  return {actions, isFirstTime, samplesIncluded: includeSamples}
}

// ── Execute ────────────────────────────────────────────────────────────

export function executeInit(plan: InitPlan, dir: string): void {
  // Build a lookup for managed file content
  const managedContent: Record<string, string> = {
    'quonfig.schema.json': JSON.stringify(storedConfigJsonSchema(), null, 2) + '\n',
    'README.md': readmeTemplate(),
    'CLAUDE.md': claudeMdTemplate(),
    'AGENTS.md': agentsMdTemplate(),
    'quonfig.json': JSON.stringify({environments: []}, null, 2) + '\n',
  }

  // Build a lookup for sample content
  const sampleContent: Record<string, string> = {}
  for (const sample of SAMPLE_FILES) {
    sampleContent[sample.path] = JSON.stringify(sample.content, null, 2) + '\n'
  }

  for (const action of plan.actions) {
    const fullPath = path.join(dir, action.path)

    switch (action.kind) {
      case 'git-init': {
        execSync('git init', {cwd: dir, stdio: 'pipe'})
        break
      }

      case 'create-dir': {
        fs.mkdirSync(fullPath, {recursive: true})
        break
      }

      case 'write-file': {
        // Ensure parent directory exists
        const parentDir = path.dirname(fullPath)
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, {recursive: true})
        }

        const content = managedContent[action.path] ?? sampleContent[action.path]
        if (content) {
          fs.writeFileSync(fullPath, content, 'utf-8')
        }

        break
      }

      case 'create-hook': {
        const hooksDir = path.dirname(fullPath)
        if (!fs.existsSync(hooksDir)) {
          fs.mkdirSync(hooksDir, {recursive: true})
        }

        fs.writeFileSync(fullPath, preCommitHookContent(), 'utf-8')
        fs.chmodSync(fullPath, 0o755)
        break
      }

      case 'update-hook': {
        const existing = fs.readFileSync(fullPath, 'utf-8')
        const appended = existing.trimEnd() + '\n\n' + preCommitHookContent().split('\n').slice(1).join('\n')
        fs.writeFileSync(fullPath, appended, 'utf-8')
        break
      }

      case 'skip-file':
      case 'skip-hook':
        // Nothing to do
        break
    }
  }
}
