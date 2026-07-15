import {expect, test} from '@oclif/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('verify', () => {
  let tmpdir: string
  let prevCwd: string

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cmd-'))
    prevCwd = process.cwd()
    process.chdir(tmpdir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
  })

  describe('--json on an invalid workspace', () => {
    // Regression (qfg-ez47): verify used to call this.exit(1) BEFORE the JSON
    // was printed, so `qfg verify --json` on an invalid workspace exited
    // non-zero with EMPTY stdout — useless exactly when there are findings to
    // report. It must now still emit the JSON result on stdout AND exit 1.
    // An empty directory (no quonfig.json) is an invalid workspace.
    test
      .stdout()
      .command(['verify', '.', '--json'])
      .catch((error) => {
        // Exit code 1 must be preserved — scripts depend on it.
        expect((error as {exitCode?: number}).exitCode ?? 1).to.equal(1)
      })
      .it('still emits the JSON result on stdout before exiting non-zero', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output).to.have.property('valid', false)
        expect(output).to.have.property('issues').that.is.an('array')
        expect(output.issues.length).to.be.greaterThan(0)
      })
  })

  describe('--json on a valid workspace', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(tmpdir, 'quonfig.json'), JSON.stringify({environments: ['production']}))
    })

    test
      .stdout()
      .command(['verify', '.', '--json'])
      .it('emits the JSON result with valid:true and exits 0', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output).to.have.property('valid', true)
      })
  })

  describe('human output on an invalid workspace', () => {
    test
      .stdout()
      .command(['verify', '.'])
      .catch((error) => {
        expect((error as {exitCode?: number}).exitCode ?? 1).to.equal(1)
      })
      .it('prints a FAILED report and exits non-zero', (ctx) => {
        expect(ctx.stdout).to.match(/FAILED/)
      })
  })
})
