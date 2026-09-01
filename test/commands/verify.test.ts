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
        expect((error as {oclif?: {exit?: number}}).oclif?.exit ?? 1).to.equal(1)
      })
      .it('still emits the JSON result on stdout before exiting non-zero', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output).to.have.property('valid', false)
        expect(output).to.have.property('issues').that.is.an('array')
        expect(output.issues.length).to.be.greaterThan(0)
      })

    // qfg-hzmb: the fix teaches catch() to print a JSON error envelope under
    // --json. `this.exit(1)` throws an ExitError, which is control flow, not a
    // failure — reporting it too would append a SECOND JSON document here and
    // break every consumer that pipes this into a parser.
    test
      .stdout()
      .command(['verify', '.', '--json'])
      .catch(/.*/)
      .it('emits exactly one JSON document — the ExitError is not reported too', (ctx) => {
        expect(ctx.stdout).to.not.include('EEXIT')
        // A second, appended document would make this throw.
        expect(() => JSON.parse(ctx.stdout)).to.not.throw()
        // ...and the one document is the verify payload, not an error envelope.
        const output = JSON.parse(ctx.stdout) as Record<string, unknown>
        expect(output).to.have.property('valid', false)
        expect(output).to.not.have.property('error')
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
