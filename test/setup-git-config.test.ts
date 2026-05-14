import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Guards the global test setup (test/setup.ts): every git process spawned
 * during the test run — including ones spawned inside src/ code — must see
 * core.autocrlf=false so LF fixtures round-trip through git unchanged on
 * Windows CI. If test/setup.ts stops being required (or stops injecting the
 * config), these assertions fail.
 */
describe('global git config (test/setup.ts)', () => {
  it('injects core.autocrlf=false into every spawned git process', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-config-check-'))
    try {
      execFileSync('git', ['init', '-q'], {cwd: tmp})
      const resolved = execFileSync('git', ['config', '--get', 'core.autocrlf'], {
        cwd: tmp,
        encoding: 'utf8',
      }).trim()
      expect(resolved).to.equal('false')
    } finally {
      fs.rmSync(tmp, {force: true, recursive: true})
    }
  })

  it('round-trips an LF file through git add/commit/checkout without CRLF conversion', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-lf-roundtrip-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, {cwd: tmp, encoding: 'utf8'})
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@quonfig.invalid')
      git('config', 'user.name', 'qfg test')
      const file = path.join(tmp, 'a.json')
      fs.writeFileSync(file, '{"k":1}\n')
      git('add', '.')
      git('commit', '-q', '-m', 'add')
      // Wipe the working copy and let git restore it from the index/object db.
      fs.rmSync(file)
      git('checkout', '--', 'a.json')
      expect(fs.readFileSync(file, 'utf8')).to.equal('{"k":1}\n')
    } finally {
      fs.rmSync(tmp, {force: true, recursive: true})
    }
  })
})
