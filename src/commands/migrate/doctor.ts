import {Flags} from '@oclif/core'

import {BaseCommand} from '../../index.js'
import {type DoctorContext, type DoctorSession, formatHumanReport, runDoctor} from '../../migrate/doctor.js'
import {loadTokens} from '../../util/token-storage.js'

const SUPPORTED_SOURCES = new Set(['launch'])

const defaultLoadSession = async (): Promise<DoctorSession | null> => {
  // TODO(qfg-kr7.5): pick the token set keyed by the resolved workosOrgId.
  let store
  try {
    store = await loadTokens()
  } catch {
    // Legacy on-disk shape (pre-qfg-kr7.3) — treat as "not logged in" so the
    // doctor can tell the user to re-run `qfg login` rather than crashing.
    return null
  }

  const tokens = store ? Object.values(store.tokensByOrg)[0] : undefined
  if (!tokens?.access_token) return null
  return {expiresAt: tokens.expires_at ?? 0}
}

export default class MigrateDoctor extends BaseCommand {
  static description =
    'Preflight health checks for `qfg migrate`. Verifies auth, workspace provisioning, working tree, and identifier collisions.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --from launch --api-key $LAUNCH_API_KEY',
    '<%= config.bin %> <%= command.id %> --dir ./my-workspace --language node',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    'api-key': Flags.string({
      description: 'Legacy SDK API key to validate against the source',
      required: false,
    }),
    dir: Flags.string({
      default: '.',
      description: 'Workspace directory to check (git clean / identifier map)',
    }),
    from: Flags.string({
      default: 'launch',
      description: 'Legacy SDK to migrate from',
      options: ['launch'],
    }),
    language: Flags.string({
      description: 'Customer SDK language — used to warn when datadir mode is unavailable (e.g. javascript-browser)',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(MigrateDoctor)

    if (!SUPPORTED_SOURCES.has(flags.from)) {
      this.err(`Unsupported --from source: ${flags.from}. Only 'launch' is supported today.`)
      return
    }

    const ctx: DoctorContext = {
      apiKey: flags['api-key'],
      dir: flags.dir,
      from: flags.from,
      language: flags.language,
      loadSession: defaultLoadSession,
    }

    const report = await runDoctor(ctx)

    if (this.jsonEnabled()) {
      process.stdout.write(JSON.stringify(report) + '\n')
    } else {
      this.log(formatHumanReport(report))
    }

    if (!report.passed) {
      this.exit(1)
    }
  }
}
