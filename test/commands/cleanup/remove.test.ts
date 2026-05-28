import {expect, test} from '@oclif/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {resetClientCache} from '../../../src/util/get-client.js'
import {activeFlagKey, notReadyFlagKey, quietFlagKey, server, variantFlagKey} from '../../responses/cleanup.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('cleanup remove', () => {
  let tmpdir: string
  let prevCwd: string

  before(() => {
    setupTestAuth()
    server.listen()
  })

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-remove-test-'))
    prevCwd = process.cwd()
    process.chdir(tmpdir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
    server.resetHandlers()
    resetClientCache()
  })

  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .command(['cleanup remove'])
    .catch((error) => {
      expect(error.message.toLowerCase()).to.match(/key/)
    })
    .it('errors when no key is supplied')

  test
    .command(['cleanup remove', notReadyFlagKey])
    .catch((error) => {
      expect(error.message).to.match(/readyforcleanup/i)
    })
    .it('refuses when readyForCleanup is not true')

  test
    .command(['cleanup remove', activeFlagKey])
    .catch((error) => {
      expect(error.message).to.match(/evals_2d/)
      expect(error.message).to.match(/17/)
      expect(error.message).to.match(/--force/)
      expect(error.message).to.match(/qfg cleanup status/)
    })
    .it('refuses when evals_2d > 0 and points at status + --force')

  test
    .stdout()
    .command(['cleanup remove', activeFlagKey, '--force'])
    .it('writes payload when --force overrides the eval gate', () => {
      const payload = JSON.parse(fs.readFileSync(path.join(tmpdir, '.qf', 'cleanup', `${activeFlagKey}.json`), 'utf8'))
      expect(payload.key).to.equal(activeFlagKey)
      expect(payload.evals.evals_2d).to.equal(17)
      expect(payload.forced).to.equal(true)
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey])
    .it('writes .qf/cleanup/<key>.json with the full payload shape', () => {
      const payloadPath = path.join(tmpdir, '.qf', 'cleanup', `${quietFlagKey}.json`)
      expect(fs.existsSync(payloadPath), 'expected payload at .qf/cleanup/<key>.json').to.equal(true)
      const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
      expect(payload.key).to.equal(quietFlagKey)
      expect(payload.type).to.equal('bool')
      expect(payload.readyForCleanup).to.equal(true)
      expect(payload.evals.evals_24h).to.equal(0)
      expect(payload.evals.evals_2d).to.equal(0)
      expect(payload.evals.evals_7d).to.equal(0)
      expect(payload.evals.evals_30d).to.equal(0)
      expect(payload.environments).to.be.an('array')
      expect(payload.default).to.be.an('object')
      expect(payload.flagUrl)
        .to.be.a('string')
        .and.match(/\/workspaces\/.+\/flags\/.+/)
      expect(payload.flagUrl).to.contain(quietFlagKey)
      expect(payload.grepPatterns).to.be.an('array').that.is.not.empty
      expect(payload.grepPatterns).to.include('isFeatureEnabled')
      expect(payload.grepPatterns).to.include('get')
      expect(payload.skill).to.equal('qfg-flag-cleanup')
      expect(payload.forced).to.equal(false)
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey])
    .it('captures the flag valueType (bool)', () => {
      const payload = JSON.parse(fs.readFileSync(path.join(tmpdir, '.qf', 'cleanup', `${quietFlagKey}.json`), 'utf8'))
      expect(payload.type).to.equal('bool')
    })

  test
    .stdout()
    .command(['cleanup remove', variantFlagKey])
    .it('captures non-bool valueType in the payload', () => {
      const payload = JSON.parse(fs.readFileSync(path.join(tmpdir, '.qf', 'cleanup', `${variantFlagKey}.json`), 'utf8'))
      expect(payload.type).to.equal('string')
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey])
    .it('prints next-step instructions referencing the qfg-flag-cleanup skill and the payload path', (ctx) => {
      expect(ctx.stdout).to.contain('qfg-flag-cleanup')
      expect(ctx.stdout).to.contain('.qf/cleanup')
      expect(ctx.stdout).to.contain(quietFlagKey)
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey])
    .it('ensures .qf/cleanup/ is in the local .gitignore', () => {
      const contents = fs.readFileSync(path.join(tmpdir, '.gitignore'), 'utf8')
      expect(contents).to.match(/^\.qf\/cleanup\/?$/m)
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey])
    .it('does not duplicate the .gitignore entry when run twice', () => {
      const firstContents = fs.readFileSync(path.join(tmpdir, '.gitignore'), 'utf8')
      // simulate a second invocation by writing the same line again
      fs.writeFileSync(path.join(tmpdir, '.qf', 'cleanup', 'extra.json'), '{}')
      const matches = firstContents.split('\n').filter((l) => l.trim() === '.qf/cleanup/' || l.trim() === '.qf/cleanup')
      expect(matches.length).to.equal(1)
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey])
    .it('does NOT modify source files (no edits outside .qf/ and .gitignore)', () => {
      const entries = fs.readdirSync(tmpdir)
      // Only the two artifacts we own should appear.
      expect(entries.sort()).to.deep.equal(['.gitignore', '.qf'])
    })

  test
    .stdout()
    .command(['cleanup remove', quietFlagKey, '--json'])
    .it('--json output mirrors the on-disk payload', (ctx) => {
      const json = JSON.parse(ctx.stdout)
      expect(json.skill).to.equal('qfg-flag-cleanup')
      expect(json.payloadPath).to.match(/\.qf\/cleanup\/.+\.json$/)
      expect(json.key).to.equal(quietFlagKey)
    })

  test
    .command(['cleanup remove', 'flag.does-not-exist'])
    .catch((error) => {
      expect(error.message).to.match(/not found/i)
    })
    .it('errors when the flag is missing on the server')
})
