import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {executeInit, planInit} from '../../src/init/init-workspace.js'
import {SAMPLE_FILES} from '../../src/init/samples.js'
import {agentsMdTemplate, claudeMdTemplate, PRE_COMMIT_MARKER, readmeTemplate} from '../../src/init/templates.js'
import {writeWorkspaceSlug, readWorkspaceSlug} from '../../src/util/quonfig-json.js'
import {validateWorkspace} from '../../src/verify/validate.js'

const HOSTED_SCHEMA_URL = 'https://api.quonfig.com/schemas/v1/stored-config.json'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-init-'))
}

function initFresh(dir: string, samples?: boolean): void {
  const plan = planInit({dir, dryRun: false, samples})
  executeInit(plan, dir)
}

describe('qfg init', () => {
  // ── First-time detection ───────────────────────────────────────────

  describe('first-time detection', () => {
    it('detects empty directory as first-time', () => {
      const dir = tmpDir()
      try {
        const plan = planInit({dir, dryRun: false, samples: undefined})
        expect(plan.isFirstTime).to.be.true
        expect(plan.samplesIncluded).to.be.true
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('detects existing workspace dirs as update', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(path.join(dir, 'configs'))
        const plan = planInit({dir, dryRun: false, samples: undefined})
        expect(plan.isFirstTime).to.be.false
        expect(plan.samplesIncluded).to.be.false
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // ── First-time init ────────────────────────────────────────────────

  describe('first-time init', () => {
    it('creates directories, docs, quonfig.json, and samples', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        // Directories
        expect(fs.existsSync(path.join(dir, 'configs'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'feature-flags'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'segments'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'log-levels'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'schemas'))).to.be.true

        // Managed docs
        expect(fs.existsSync(path.join(dir, 'README.md'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).to.be.true

        // quonfig.json
        const envs = JSON.parse(fs.readFileSync(path.join(dir, 'quonfig.json'), 'utf8'))
        expect(envs).to.deep.equal({environments: []})

        // Samples
        for (const sample of SAMPLE_FILES) {
          expect(fs.existsSync(path.join(dir, sample.path)), `${sample.path} should exist`).to.be.true
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('skips samples with --no-samples', () => {
      const dir = tmpDir()
      try {
        initFresh(dir, false)

        // Dirs and docs still created
        expect(fs.existsSync(path.join(dir, 'configs'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'README.md'))).to.be.true

        // No samples
        for (const sample of SAMPLE_FILES) {
          expect(fs.existsSync(path.join(dir, sample.path)), `${sample.path} should NOT exist`).to.be.false
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('managed docs contain the managed header', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        for (const file of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
          const content = fs.readFileSync(path.join(dir, file), 'utf8')
          expect(content).to.include('Managed by `qfg init`')
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // ── Update mode ────────────────────────────────────────────────────

  describe('update mode', () => {
    it('overwrites managed docs but does not re-add samples', () => {
      const dir = tmpDir()
      try {
        // First init with samples
        initFresh(dir)

        // Delete a sample to simulate user removing it
        fs.unlinkSync(path.join(dir, SAMPLE_FILES[0].path))

        // Update (no --samples flag)
        initFresh(dir)

        // Managed docs still present
        expect(fs.existsSync(path.join(dir, 'README.md'))).to.be.true
        expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).to.be.true

        // Deleted sample NOT re-created
        expect(fs.existsSync(path.join(dir, SAMPLE_FILES[0].path))).to.be.false
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('adds samples on update when --samples is explicit', () => {
      const dir = tmpDir()
      try {
        // First init with samples
        initFresh(dir)

        // Delete a sample
        fs.unlinkSync(path.join(dir, SAMPLE_FILES[0].path))

        // Update with --samples
        initFresh(dir, true)

        // Sample re-created
        expect(fs.existsSync(path.join(dir, SAMPLE_FILES[0].path))).to.be.true
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does not overwrite quonfig.json if it already exists', () => {
      const dir = tmpDir()
      try {
        // Create quonfig.json with custom content
        fs.mkdirSync(path.join(dir, 'configs'))
        fs.writeFileSync(
          path.join(dir, 'quonfig.json'),
          JSON.stringify({environments: ['production', 'staging']}, null, 2),
        )

        initFresh(dir)

        // Should not have been overwritten
        const envs = JSON.parse(fs.readFileSync(path.join(dir, 'quonfig.json'), 'utf8'))
        expect(envs.environments).to.deep.equal(['production', 'staging'])
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does not overwrite existing sample files even with --samples', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        // Modify a sample
        const samplePath = path.join(dir, SAMPLE_FILES[0].path)
        fs.writeFileSync(samplePath, '{"custom": true}')

        // Re-init with --samples
        initFresh(dir, true)

        // Should NOT have been overwritten
        const content = fs.readFileSync(samplePath, 'utf8')
        expect(content).to.equal('{"custom": true}')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // ── Dry run ────────────────────────────────────────────────────────

  describe('dry run', () => {
    it('returns a plan without writing anything', () => {
      const dir = tmpDir()
      try {
        const plan = planInit({dir, dryRun: true, samples: undefined})

        // Plan should have actions
        expect(plan.actions.length).to.be.greaterThan(0)

        // Nothing should have been written
        expect(fs.readdirSync(dir)).to.be.empty
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // ── Git hook ───────────────────────────────────────────────────────

  describe('git pre-commit hook', () => {
    it('installs hook when .git exists', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(path.join(dir, '.git', 'hooks'), {recursive: true})
        initFresh(dir)

        const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit')
        expect(fs.existsSync(hookPath)).to.be.true

        const content = fs.readFileSync(hookPath, 'utf8')
        expect(content).to.include('qfg verify')
        expect(content).to.include(PRE_COMMIT_MARKER)

        // Should be executable. NTFS has no Unix executable bit, so
        // stat.mode & 0o111 is always 0 on Windows — git there runs hooks via
        // its bundled sh regardless. Only assert the bit off-Windows.
        if (process.platform !== 'win32') {
          const stat = fs.statSync(hookPath)
          expect(stat.mode & 0o111).to.be.greaterThan(0)
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('creates .git and hook when directory is not a git repo', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        expect(fs.existsSync(path.join(dir, '.git'))).to.be.true
        const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit')
        expect(fs.existsSync(hookPath)).to.be.true
        expect(fs.readFileSync(hookPath, 'utf8')).to.include('qfg verify')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does not overwrite existing hook that already has marker', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(path.join(dir, '.git', 'hooks'), {recursive: true})

        // First init installs the hook
        initFresh(dir)
        const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit')
        const original = fs.readFileSync(hookPath, 'utf8')

        // Second init should skip
        initFresh(dir)
        const after = fs.readFileSync(hookPath, 'utf8')
        expect(after).to.equal(original)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('appends to existing hook without marker', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(path.join(dir, '.git', 'hooks'), {recursive: true})
        const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit')
        fs.writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n')

        initFresh(dir)

        const content = fs.readFileSync(hookPath, 'utf8')
        expect(content).to.include('existing hook')
        expect(content).to.include('qfg verify')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // ── Workspace pin (Guard 1) ────────────────────────────────────────

  describe('workspace pin (--workspace flag)', () => {
    it('writes the workspace pin into quonfig.json when the flag is provided', async () => {
      const dir = tmpDir()
      try {
        // Simulate the init command's full flow: execute init, then write pin.
        initFresh(dir)
        await writeWorkspaceSlug(dir, {orgSlug: 'acme', workspaceSlug: 'prod'})

        // quonfig.json should now carry the pin AND keep the original environments field
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'quonfig.json'), 'utf8'))
        expect(parsed.workspace).to.equal('acme/prod')
        expect(parsed.environments).to.deep.equal([])

        const slug = await readWorkspaceSlug(dir)
        expect(slug).to.deep.equal({orgSlug: 'acme', workspaceSlug: 'prod'})
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does not write a workspace field when the flag is absent', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'quonfig.json'), 'utf8'))
        expect(parsed).to.not.have.property('workspace')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  // ── Hosted JSON Schema (qfg-sv3c) ──────────────────────────────────

  describe('hosted JSON Schema reference', () => {
    it('does NOT emit quonfig.schema.json on a fresh init', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)
        expect(fs.existsSync(path.join(dir, 'quonfig.schema.json')), 'quonfig.schema.json should not be created').to.be
          .false
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('does not regenerate or overwrite a stale quonfig.schema.json on re-init', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        // Simulate a customer with a stale schema file from a previous CLI version.
        const stalePath = path.join(dir, 'quonfig.schema.json')
        const staleContent = '{"stale": true}'
        fs.writeFileSync(stalePath, staleContent)
        const staleMtime = fs.statSync(stalePath).mtimeMs

        // Force enough clock separation that an unintended write would change mtime.
        const plan = planInit({dir, dryRun: false, samples: undefined})
        executeInit(plan, dir)

        // File still present (we don't migrate) and untouched (we don't overwrite).
        expect(fs.existsSync(stalePath)).to.be.true
        expect(fs.readFileSync(stalePath, 'utf8')).to.equal(staleContent)
        expect(fs.statSync(stalePath).mtimeMs).to.equal(staleMtime)

        // The plan must not list quonfig.schema.json among its actions at all.
        const touchesSchema = plan.actions.some((a) => a.path === 'quonfig.schema.json')
        expect(touchesSchema, 'plan should not contain any quonfig.schema.json action').to.be.false
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('templates point at the hosted URL and never reference ./quonfig.schema.json', () => {
      for (const tpl of [readmeTemplate(), claudeMdTemplate(), agentsMdTemplate()]) {
        expect(tpl).to.not.include('./quonfig.schema.json')
      }
      // README + CLAUDE prose/snippets must mention the hosted URL.
      expect(readmeTemplate()).to.include(HOSTED_SCHEMA_URL)
      expect(claudeMdTemplate()).to.include(HOSTED_SCHEMA_URL)
    })
  })

  // ── AGENTS.md surface steering (qfg-k4m6.4) ────────────────────────
  //
  // Asserted against the file `qfg init` actually renders to disk, not the
  // template string, so a regression in either one is caught.

  describe('AGENTS.md: qfg vs MCP steering', () => {
    let rendered = ''

    before(() => {
      const dir = tmpDir()
      try {
        initFresh(dir)
        rendered = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('routes in-repo work to qfg and checkout-less surfaces to the MCP', () => {
      expect(rendered).to.include('MCP')
      expect(rendered).to.match(/checked out/i)
      expect(rendered).to.include('Slack')
      expect(rendered).to.include('claude.ai')
    })

    it('warns that setting a value replaces the environment rules on BOTH surfaces', () => {
      expect(rendered).to.include('qfg set-default')
      expect(rendered).to.include('qfg set-rollout')
      expect(rendered).to.include('set_flag')
      expect(rendered).to.match(/single unconditional rule/i)
      // The MCP has the guard; the CLI does not — that asymmetry is the point.
      expect(rendered).to.include('TARGETING_RULES_PRESENT')
      expect(rendered).to.match(/no such guard|no guard/i)
    })

    it('tells the agent to read the rules before writing a value', () => {
      expect(rendered).to.include('qfg info')
      expect(rendered).to.include('get_flag')
    })

    it('records that log-level writes are surgical on both surfaces', () => {
      expect(rendered).to.include('qfg log-level')
      expect(rendered).to.include('set_log_level')
      expect(rendered).to.match(/surgical/i)
    })
  })

  // ── Validation ─────────────────────────────────────────────────────

  describe('validation', () => {
    it('workspace with samples passes qfg verify', () => {
      const dir = tmpDir()
      try {
        initFresh(dir)

        const result = validateWorkspace(dir)
        const errors = result.issues.filter((i) => i.severity === 'error')
        expect(errors, `Validation errors: ${JSON.stringify(errors, null, 2)}`).to.be.empty
        expect(result.valid).to.be.true
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('workspace without samples passes qfg verify', () => {
      const dir = tmpDir()
      try {
        initFresh(dir, false)

        const result = validateWorkspace(dir)
        const errors = result.issues.filter((i) => i.severity === 'error')
        expect(errors).to.be.empty
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })
})
