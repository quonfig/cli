import {isWorkingTreeClean as defaultIsWorkingTreeClean} from '../util/git-ops.js'
import {detectCollisions, type IdentifierMap, readIdentifierMap} from './identifier-map.js'

export interface DoctorCheck {
  fix?: string
  message: string
  name: string
  passed: boolean
}

export interface DoctorReport {
  checks: DoctorCheck[]
  passed: boolean
}

export interface DoctorSession {
  expiresAt: number
}

export interface DoctorContext {
  apiKey?: string
  dir: string
  from: string
  getWorkspaceGitRepo?: () => Promise<null | string>
  isWorkingTreeClean?: (dir: string) => Promise<boolean>
  language?: string
  loadSession?: () => Promise<DoctorSession | null>
  readExistingMap?: (dir: string) => IdentifierMap | null
  validateSourceAuth?: (from: string, apiKey: string) => Promise<boolean>
}

const BROWSER_LANGUAGE_ALIASES = new Set(['javascript-browser', 'js-browser', 'browser', 'browser-js'])

const checkLegacyApiKey = async (ctx: DoctorContext): Promise<DoctorCheck> => {
  if (!ctx.apiKey) {
    return {
      message: `Skipped -- no --api-key provided for source "${ctx.from}".`,
      name: 'legacy-api-key',
      passed: true,
    }
  }

  const validate = ctx.validateSourceAuth
  if (!validate) {
    return {
      fix: `Auth validation for source "${ctx.from}" is not yet implemented. Run without --api-key to skip this check, or upgrade the CLI.`,
      message: `No validator available for source "${ctx.from}".`,
      name: 'legacy-api-key',
      passed: false,
    }
  }

  try {
    const ok = await validate(ctx.from, ctx.apiKey)
    if (ok) {
      return {
        message: `${ctx.from} API key accepted.`,
        name: 'legacy-api-key',
        passed: true,
      }
    }

    return {
      fix: `Double-check the ${ctx.from} API key you passed to --api-key. Generate a fresh read-only token in the ${ctx.from} dashboard and retry.`,
      message: `${ctx.from} API key was rejected.`,
      name: 'legacy-api-key',
      passed: false,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      fix: `Check network connectivity to the ${ctx.from} API, then retry.`,
      message: `${ctx.from} API key validation errored: ${msg}`,
      name: 'legacy-api-key',
      passed: false,
    }
  }
}

const checkQfgLogin = async (ctx: DoctorContext): Promise<DoctorCheck> => {
  const loader = ctx.loadSession
  if (!loader) {
    return {
      fix: 'Run `qfg login`.',
      message: 'No session loader wired -- assume not logged in.',
      name: 'qfg-login',
      passed: false,
    }
  }

  const session = await loader()
  if (!session) {
    return {
      fix: 'Run `qfg login` to authenticate with Quonfig.',
      message: 'No Quonfig session found. Run `qfg login`.',
      name: 'qfg-login',
      passed: false,
    }
  }

  if (session.expiresAt <= Date.now()) {
    return {
      fix: 'Run `qfg login` again to refresh the session.',
      message: 'Quonfig session is expired.',
      name: 'qfg-login',
      passed: false,
    }
  }

  return {
    message: 'Quonfig session is valid.',
    name: 'qfg-login',
    passed: true,
  }
}

const checkWorkspaceProvisioned = async (ctx: DoctorContext): Promise<DoctorCheck> => {
  const getRepo = ctx.getWorkspaceGitRepo
  if (!getRepo) {
    return {
      fix: 'Pass --workspace or run `qfg workspace use <slug>` so the doctor can look up the target workspace.',
      message: 'Cannot look up workspace -- no workspace selected.',
      name: 'workspace-provisioned',
      passed: false,
    }
  }

  try {
    const repo = await getRepo()
    if (!repo) {
      return {
        fix: 'Create or provision the workspace in the Quonfig UI (its gitRepoFullName must be set) before running with --push.',
        message: 'Target workspace has no gitRepoFullName set.',
        name: 'workspace-provisioned',
        passed: false,
      }
    }

    return {
      message: `Workspace git repo: ${repo}.`,
      name: 'workspace-provisioned',
      passed: true,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      fix: 'Check that the workspace exists and that your session has access to it.',
      message: `Workspace lookup failed: ${msg}`,
      name: 'workspace-provisioned',
      passed: false,
    }
  }
}

const checkSdkDatadirSupport = (ctx: DoctorContext): DoctorCheck => {
  const language = (ctx.language ?? '').toLowerCase()
  if (BROWSER_LANGUAGE_ALIASES.has(language)) {
    return {
      fix: 'Use Flow B (--push to the workspace git repo). Browser JavaScript SDKs do not read from a local datadir.',
      message: `Browser JavaScript SDK has no datadir mode -- Flow B (--push) is required.`,
      name: 'sdk-datadir-support',
      passed: false,
    }
  }

  return {
    message: language
      ? `SDK language "${language}" supports datadir mode.`
      : 'No SDK language specified; assuming datadir-capable.',
    name: 'sdk-datadir-support',
    passed: true,
  }
}

const checkGitWorkingTreeClean = async (ctx: DoctorContext): Promise<DoctorCheck> => {
  const fn = ctx.isWorkingTreeClean ?? defaultIsWorkingTreeClean
  try {
    const clean = await fn(ctx.dir)
    if (clean) {
      return {
        message: `Working tree at ${ctx.dir} is clean.`,
        name: 'git-working-tree-clean',
        passed: true,
      }
    }

    return {
      fix: 'Commit or stash uncommitted changes in the output directory before running the migration.',
      message: `Working tree at ${ctx.dir} has uncommitted changes.`,
      name: 'git-working-tree-clean',
      passed: false,
    }
  } catch {
    return {
      message: `Output directory ${ctx.dir} is not a git repo -- skipping working-tree check.`,
      name: 'git-working-tree-clean',
      passed: true,
    }
  }
}

const checkIdentifierCollisions = (ctx: DoctorContext): DoctorCheck => {
  const reader = ctx.readExistingMap ?? readIdentifierMap
  const map = reader(ctx.dir)
  if (!map) {
    return {
      message: 'No existing identifier map found -- nothing to collide with yet.',
      name: 'identifier-collisions',
      passed: true,
    }
  }

  const collisions = detectCollisions(map)
  if (collisions.length === 0) {
    return {
      message: `Existing identifier map has ${Object.keys(map).length} entr${Object.keys(map).length === 1 ? 'y' : 'ies'} with no case-insensitive collisions.`,
      name: 'identifier-collisions',
      passed: true,
    }
  }

  const lines = collisions.map(
    (c) => `    - "${c.quonfigKeyA}" vs "${c.quonfigKeyB}" (legacy keys "${c.legacyKeyA}", "${c.legacyKeyB}")`,
  )
  return {
    fix: 'Rename one of the colliding Quonfig keys in the identifier map so they differ by more than just case.',
    message: `Found ${collisions.length} case-insensitive collision${collisions.length === 1 ? '' : 's'} in existing identifier map:\n${lines.join('\n')}`,
    name: 'identifier-collisions',
    passed: false,
  }
}

export const runDoctor = async (ctx: DoctorContext): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [
    await checkLegacyApiKey(ctx),
    await checkQfgLogin(ctx),
    await checkWorkspaceProvisioned(ctx),
    checkSdkDatadirSupport(ctx),
    await checkGitWorkingTreeClean(ctx),
    checkIdentifierCollisions(ctx),
  ]

  return {
    checks,
    passed: checks.every((c) => c.passed),
  }
}

export const formatHumanReport = (report: DoctorReport): string => {
  const lines: string[] = []
  for (const check of report.checks) {
    const label = check.passed ? 'pass' : 'fail'
    lines.push(`  ${label}  ${check.name}`)
    const messageLines = check.message.split('\n')
    for (const line of messageLines) {
      lines.push(`          ${line}`)
    }

    if (!check.passed && check.fix) {
      lines.push(`          Fix: ${check.fix}`)
    }
  }

  lines.push('')
  if (report.passed) {
    lines.push('All checks passed. Ready to migrate.')
  } else {
    const failed = report.checks.filter((c) => !c.passed).length
    lines.push(`${failed} check${failed === 1 ? '' : 's'} failed. See "Fix:" hints above.`)
  }

  return lines.join('\n')
}
