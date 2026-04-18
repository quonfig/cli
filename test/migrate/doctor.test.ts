import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  type DoctorContext,
  type DoctorReport,
  formatHumanReport,
  runDoctor,
} from '../../src/migrate/doctor.js'

const allStubs = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  apiKey: 'valid-key',
  dir: process.cwd(),
  from: 'launch',
  language: 'node',
  getWorkspaceGitRepo: async () => 'my-org/my-workspace',
  isWorkingTreeClean: async () => true,
  loadSession: async () => ({expiresAt: Date.now() + 3_600_000}),
  readExistingMap: () => ({} as Record<string, string>),
  validateSourceAuth: async () => true,
  ...overrides,
})

describe('migrate/doctor', () => {
  describe('runDoctor', () => {
    it('returns passed=true when every check passes', async () => {
      const report = await runDoctor(allStubs())
      expect(report.passed).to.equal(true)
      const failed = report.checks.filter((c) => !c.passed)
      expect(failed, `unexpected failures: ${JSON.stringify(failed)}`).to.deep.equal([])
    })

    it('includes every named check in the report in a stable order', async () => {
      const report = await runDoctor(allStubs())
      const names = report.checks.map((c) => c.name)
      expect(names).to.deep.equal([
        'legacy-api-key',
        'qfg-login',
        'workspace-provisioned',
        'sdk-datadir-support',
        'git-working-tree-clean',
        'identifier-collisions',
      ])
    })

    it('fails the legacy-api-key check when validateSourceAuth returns false', async () => {
      const report = await runDoctor(
        allStubs({validateSourceAuth: async () => false}),
      )
      const check = report.checks.find((c) => c.name === 'legacy-api-key')!
      expect(check.passed).to.equal(false)
      expect(check.message.toLowerCase()).to.match(/api key|launch/)
      expect(report.passed).to.equal(false)
    })

    it('passes legacy-api-key with "skipped — no api key provided" when apiKey is empty', async () => {
      const report = await runDoctor(allStubs({apiKey: undefined}))
      const check = report.checks.find((c) => c.name === 'legacy-api-key')!
      expect(check.passed).to.equal(true)
      expect(check.message.toLowerCase()).to.contain('skipped')
    })

    it('fails qfg-login when loadSession returns null', async () => {
      const report = await runDoctor(allStubs({loadSession: async () => null}))
      const check = report.checks.find((c) => c.name === 'qfg-login')!
      expect(check.passed).to.equal(false)
      expect(check.message).to.match(/qfg login/)
    })

    it('fails qfg-login when the session is expired', async () => {
      const report = await runDoctor(
        allStubs({loadSession: async () => ({expiresAt: Date.now() - 1000})}),
      )
      const check = report.checks.find((c) => c.name === 'qfg-login')!
      expect(check.passed).to.equal(false)
      expect(check.message.toLowerCase()).to.contain('expired')
    })

    it('fails workspace-provisioned when getWorkspaceGitRepo returns null', async () => {
      const report = await runDoctor(allStubs({getWorkspaceGitRepo: async () => null}))
      const check = report.checks.find((c) => c.name === 'workspace-provisioned')!
      expect(check.passed).to.equal(false)
      expect(check.message.toLowerCase()).to.match(/workspace|gitrepo/)
    })

    it('fails sdk-datadir-support when language is browser javascript', async () => {
      const report = await runDoctor(allStubs({language: 'javascript-browser'}))
      const check = report.checks.find((c) => c.name === 'sdk-datadir-support')!
      expect(check.passed).to.equal(false)
      expect(check.message.toLowerCase()).to.match(/browser|flow b|datadir/)
    })

    it('passes sdk-datadir-support for supported languages', async () => {
      for (const language of ['node', 'go', 'javascript']) {
        const report = await runDoctor(allStubs({language}))
        const check = report.checks.find((c) => c.name === 'sdk-datadir-support')!
        expect(check.passed, `language=${language}`).to.equal(true)
      }
    })

    it('fails git-working-tree-clean when isWorkingTreeClean returns false', async () => {
      const report = await runDoctor(allStubs({isWorkingTreeClean: async () => false}))
      const check = report.checks.find((c) => c.name === 'git-working-tree-clean')!
      expect(check.passed).to.equal(false)
      expect(check.message.toLowerCase()).to.match(/commit|stash|uncommitted/)
    })

    it('fails identifier-collisions when the map has a case-only collision', async () => {
      const report = await runDoctor(
        allStubs({readExistingMap: () => ({legacyA: 'foo', legacyB: 'FOO'})}),
      )
      const check = report.checks.find((c) => c.name === 'identifier-collisions')!
      expect(check.passed).to.equal(false)
      expect(check.message).to.match(/collision|case/i)
    })

    it('passes identifier-collisions when no map exists', async () => {
      const report = await runDoctor(allStubs({readExistingMap: () => null}))
      const check = report.checks.find((c) => c.name === 'identifier-collisions')!
      expect(check.passed).to.equal(true)
    })
  })

  describe('formatHumanReport', () => {
    const mkReport = (): DoctorReport => ({
      checks: [
        {message: 'API key accepted', name: 'legacy-api-key', passed: true},
        {
          fix: 'Run `qfg login` to sign in.',
          message: 'Not logged in',
          name: 'qfg-login',
          passed: false,
        },
      ],
      passed: false,
    })

    it('prefixes each passing check with a pass label and failing with fail', () => {
      const out = formatHumanReport(mkReport())
      expect(out).to.match(/^\s*pass\s+legacy-api-key/m)
      expect(out).to.match(/^\s*fail\s+qfg-login/m)
    })

    it('contains no emoji characters (constitution: no emojis)', () => {
      // Checks that there are no non-ASCII symbol/emoji chars in the output.
      const out = formatHumanReport(mkReport())
      // eslint-disable-next-line no-control-regex
      expect(out).to.match(/^[\x00-\x7F]+$/)
    })

    it('prints actionable fix hints for failing checks', () => {
      const out = formatHumanReport(mkReport())
      expect(out).to.contain('Run `qfg login`')
    })

    it('ends with the "Ready to migrate" line when all checks pass', () => {
      const report: DoctorReport = {
        checks: [{message: 'ok', name: 'legacy-api-key', passed: true}],
        passed: true,
      }
      const out = formatHumanReport(report)
      expect(out).to.contain('All checks passed. Ready to migrate.')
    })
  })

  describe('git-working-tree-clean check (integration with real git)', () => {
    let tmpdir: string
    let prevCwd: string

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-git-'))
      prevCwd = process.cwd()
      execFileSync('git', ['init', '--initial-branch=main'], {cwd: tmpdir})
      execFileSync('git', ['config', 'user.email', 't@t'], {cwd: tmpdir})
      execFileSync('git', ['config', 'user.name', 't'], {cwd: tmpdir})
      fs.writeFileSync(path.join(tmpdir, 'README.md'), '# r\n')
      execFileSync('git', ['add', '.'], {cwd: tmpdir})
      execFileSync('git', ['commit', '-m', 'init'], {cwd: tmpdir})
    })

    afterEach(() => {
      process.chdir(prevCwd)
      fs.rmSync(tmpdir, {force: true, recursive: true})
    })

    it('passes on a clean repo using the real isWorkingTreeClean default', async () => {
      const report = await runDoctor({
        apiKey: undefined,
        dir: tmpdir,
        from: 'launch',
        language: 'node',
        getWorkspaceGitRepo: async () => 'org/ws',
        loadSession: async () => ({expiresAt: Date.now() + 3_600_000}),
        readExistingMap: () => null,
        validateSourceAuth: async () => true,
      })
      const check = report.checks.find((c) => c.name === 'git-working-tree-clean')!
      expect(check.passed).to.equal(true)
    })

    it('fails when the working tree has an uncommitted file', async () => {
      fs.writeFileSync(path.join(tmpdir, 'dirty.txt'), 'dirty\n')
      const report = await runDoctor({
        apiKey: undefined,
        dir: tmpdir,
        from: 'launch',
        language: 'node',
        getWorkspaceGitRepo: async () => 'org/ws',
        loadSession: async () => ({expiresAt: Date.now() + 3_600_000}),
        readExistingMap: () => null,
        validateSourceAuth: async () => true,
      })
      const check = report.checks.find((c) => c.name === 'git-working-tree-clean')!
      expect(check.passed).to.equal(false)
    })
  })
})
