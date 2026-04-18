import {expect, test} from '@oclif/test'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('migrate doctor', () => {
  let tmpdir: string
  let prevCwd: string

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-doctor-'))
    prevCwd = process.cwd()
    // initialize a clean git repo so the working-tree check has something to look at
    execFileSync('git', ['init', '--initial-branch=main'], {cwd: tmpdir})
    execFileSync('git', ['config', 'user.email', 't@t'], {cwd: tmpdir})
    execFileSync('git', ['config', 'user.name', 't'], {cwd: tmpdir})
    fs.writeFileSync(path.join(tmpdir, 'README.md'), '# r\n')
    execFileSync('git', ['add', '.'], {cwd: tmpdir})
    execFileSync('git', ['commit', '-m', 'init'], {cwd: tmpdir})
    process.chdir(tmpdir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
    cleanupTestAuth()
  })

  describe('--json output', () => {
    beforeEach(() => {
      setupTestAuth()
    })

    test
      .stdout()
      .command(['migrate:doctor', '--json', '--dir', '.', '--language', 'node'])
      .catch((err) => {
        // Expected — workspace-provisioned will fail since we have no API client,
        // but the JSON output must still be valid on stdout before exit.
        expect((err as {exitCode?: number}).exitCode ?? 1).to.equal(1)
      })
      .it('emits valid JSON with a checks array', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output).to.have.property('checks').that.is.an('array')
        expect(output).to.have.property('passed').that.is.a('boolean')
        for (const check of output.checks) {
          expect(check).to.have.property('name').that.is.a('string')
          expect(check).to.have.property('passed').that.is.a('boolean')
          expect(check).to.have.property('message').that.is.a('string')
        }

        const names = output.checks.map((c: {name: string}) => c.name)
        expect(names).to.include('qfg-login')
        expect(names).to.include('git-working-tree-clean')
        expect(names).to.include('identifier-collisions')
      })
  })

  describe('when not logged in', () => {
    test
      .stdout()
      .command(['migrate:doctor', '--json', '--dir', '.'])
      .catch((err) => {
        expect((err as {exitCode?: number}).exitCode ?? 1).to.equal(1)
      })
      .it('reports qfg-login as failed', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        const loginCheck = output.checks.find((c: {name: string}) => c.name === 'qfg-login')
        expect(loginCheck).to.exist
        expect(loginCheck.passed).to.equal(false)
        expect(loginCheck.message).to.match(/qfg login/i)
        expect(output.passed).to.equal(false)
      })
  })

  describe('human output', () => {
    test
      .stdout()
      .command(['migrate:doctor', '--dir', '.'])
      .catch(() => {
        /* ignore non-zero exit */
      })
      .it('prints per-check pass/fail labels and contains no emoji', (ctx) => {
        expect(ctx.stdout).to.match(/\bfail\b/)
        expect(ctx.stdout).to.match(/qfg-login/)
        // eslint-disable-next-line no-control-regex
        expect(ctx.stdout).to.match(/^[\x00-\x7F]+$/)
      })
  })

  describe('unsupported --from source', () => {
    test
      .command(['migrate:doctor', '--from', 'launchdarkly'])
      .catch((err) => {
        // oclif Flags.options validation rejects this at parse time
        expect(err.message.toLowerCase()).to.match(/launch/)
      })
      .it('rejects sources other than launch')
  })
})
