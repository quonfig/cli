import {Flags} from '@oclif/core'
import path from 'node:path'

import {
  DEFAULT_SKILLS_DIR,
  addPointer,
  executeInstall,
  hasPointer,
  planInstall,
  pointerLine,
} from '../../agent/install-skill.js'
import {BaseCommand} from '../../index.js'
import {JsonObj} from '../../result.js'

export default class AgentInstallSkill extends BaseCommand {
  static description = `Install the Quonfig agent skill into this repo so coding agents use Quonfig correctly.

Writes .claude/skills/quonfig/ (SKILL.md + references/) — the same files as
\`claude plugin install quonfig@quonfig\` from github.com/quonfig/skills, embedded
in this qfg build (no network). Claude Code picks the skill up automatically;
for Codex, Cursor and other agents that read AGENTS.md, add --add-pointer.

Safe to re-run: files still as qfg wrote them are upgraded in place, files you
edited are left alone (the command fails and lists them) unless you pass --force.

This skill is for APPLICATION repos (SDK + qfg + MCP usage). A workspace repo
created by \`qfg init\` has its own AGENTS.md/CLAUDE.md for editing config JSON.`

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --add-pointer',
    '<%= config.bin %> <%= command.id %> --dir .agents/skills',
    '<%= config.bin %> <%= command.id %> --force',
  ]

  static flags = {
    'add-pointer': Flags.boolean({
      default: false,
      description: 'Also append a one-line pointer to the skill in ./AGENTS.md (created if missing)',
    }),
    dir: Flags.string({
      default: DEFAULT_SKILLS_DIR,
      description: 'Skills directory to install into, relative to the current directory',
    }),
    force: Flags.boolean({
      default: false,
      description: 'Overwrite skill files you have edited locally',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(AgentInstallSkill)
    const repoDir = process.cwd()
    const skillsDir = path.resolve(repoDir, flags.dir)
    const plan = planInstall({force: flags.force, skillsDir})
    const relSkillDir = path.relative(repoDir, plan.skillDir) || '.'

    if (plan.conflicts.length > 0) {
      const list = plan.conflicts.map((p) => `  ${path.join(relSkillDir, p)}`).join('\n')
      return this.err(
        `These Quonfig skill files were edited locally and differ from skill v${plan.version}:\n${list}\nNothing was written. Re-run with --force to overwrite them.`,
        {conflicts: plan.conflicts, skillDir: relSkillDir, version: plan.version},
      )
    }

    executeInstall(plan)

    const counts: Record<string, number> = {}
    for (const f of plan.files) counts[f.status] = (counts[f.status] ?? 0) + 1

    let pointer: string | undefined
    if (flags['add-pointer']) {
      pointer = addPointer(repoDir, plan.skillDir)
    }

    if (!this.jsonEnabled()) {
      const changed = plan.files.filter((f) => f.status !== 'unchanged')
      if (changed.length === 0) {
        this.log(`Quonfig skill v${plan.version} already up to date in ${relSkillDir}`)
      } else {
        this.log(`Quonfig skill v${plan.version} -> ${relSkillDir}`)
        for (const f of changed) this.log(`  ${f.status.padEnd(8)} ${f.path}`)
      }

      if (pointer === 'added') this.log('Added a pointer to the skill in AGENTS.md')
      else if (pointer === 'present') this.log('AGENTS.md already points at the skill')
      else if (!hasPointer(repoDir, plan.skillDir)) {
        this.log('\nUsing Codex, Cursor, or another agent that reads AGENTS.md? Re-run with --add-pointer, or add:')
        this.log(`  ${pointerLine(path.relative(repoDir, plan.skillDir))}`)
      }
    }

    return {
      counts,
      files: plan.files.map((f) => ({path: f.path, status: f.status})),
      pointer: pointer ?? null,
      skillDir: relSkillDir,
      version: plan.version,
    }
  }
}
