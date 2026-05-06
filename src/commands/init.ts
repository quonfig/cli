import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../index.js'
import {executeInit, planInit} from '../init/init-workspace.js'
import {writeWorkspaceSlug} from '../util/quonfig-json.js'

export default class Init extends BaseCommand {
  static args = {
    directory: Args.string({
      default: '.',
      description: 'Target directory (default: current directory)',
    }),
  }

  static description = 'Initialize or update a Quonfig workspace'

  static examples = [
    '<%= config.bin %> init',
    '<%= config.bin %> init ./my-workspace',
    '<%= config.bin %> init --no-samples',
    '<%= config.bin %> init --samples',
    '<%= config.bin %> init --dry-run',
  ]

  static flags = {
    'dry-run': Flags.boolean({
      default: false,
      description: 'Show what would be done without writing anything',
    }),
    samples: Flags.boolean({
      allowNo: true,
      description: 'Include sample configs (default: yes on first init, no on update)',
    }),
    workspace: Flags.string({
      description: 'Workspace pin in <org-slug>/<workspace-slug> form (Guard 1). If omitted, no pin is written.',
      required: false,
    }),
  }

  public async run(): Promise<object> {
    const {args, flags} = await this.parse(Init)
    const dir = args.directory

    const plan = planInit({
      dir,
      dryRun: flags['dry-run'],
      samples: flags.samples,
    })

    const mode = plan.isFirstTime ? 'Initializing' : 'Updating'
    const writeActions = plan.actions.filter((a) => a.kind !== 'skip-file' && a.kind !== 'skip-hook')
    const skipActions = plan.actions.filter((a) => a.kind === 'skip-file' || a.kind === 'skip-hook')

    if (flags['dry-run']) {
      this.log(`${mode} workspace (dry run)\n`)

      if (writeActions.length > 0) {
        this.log('Would perform:')
        for (const action of writeActions) {
          this.log(`  + ${action.description}`)
        }
      }

      if (flags.workspace) {
        this.log(`  + Pin quonfig.json to workspace "${flags.workspace}"`)
      }

      if (skipActions.length > 0) {
        this.log('\nSkipped:')
        for (const action of skipActions) {
          this.log(`  - ${action.description}`)
        }
      }

      if (writeActions.length === 0) {
        this.log('  Nothing to do.')
      }

      if (this.jsonEnabled()) {
        return {
          actions: plan.actions,
          dryRun: true,
          isFirstTime: plan.isFirstTime,
          samplesIncluded: plan.samplesIncluded,
        }
      }

      return plan
    }

    // Execute for real
    executeInit(plan, dir)

    // If the user passed --workspace, pin the slug in quonfig.json
    // (Guard 1 in project/plans/cli-git-sync.md). We deliberately keep this
    // non-interactive: flag → write, no flag → no write. Users who need the
    // pin later can run `qfg pull` (backfills) or edit the file directly.
    if (flags.workspace) {
      const parts = flags.workspace.split('/')
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        this.error(
          `--workspace must be in <org-slug>/<workspace-slug> form (e.g. acme/foo). Got: ${JSON.stringify(flags.workspace)}.`,
        )
      }

      await writeWorkspaceSlug(dir, {orgSlug: parts[0]!, workspaceSlug: parts[1]!})
    }

    this.log(`${mode} workspace: ${dir === '.' ? process.cwd() : dir}\n`)

    for (const action of writeActions) {
      this.log(`  + ${action.description}`)
    }

    if (flags.workspace) {
      this.log(`  + Pin quonfig.json to workspace "${flags.workspace}"`)
    }

    for (const action of skipActions) {
      this.log(`  - ${action.description}`)
    }

    if (!plan.samplesIncluded && plan.isFirstTime) {
      this.log('\nSample data skipped. Run `qfg init --samples` to add examples.')
    } else if (!plan.isFirstTime && !plan.samplesIncluded) {
      this.log('\nDocs updated. Run `qfg init --samples` to add example configs.')
    }

    this.log('\nRun `qfg verify` to validate the workspace.')

    if (this.jsonEnabled()) {
      return {
        actions: plan.actions,
        dryRun: false,
        isFirstTime: plan.isFirstTime,
        samplesIncluded: plan.samplesIncluded,
      }
    }

    return plan
  }
}
