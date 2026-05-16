import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  appendFrictionEntry,
  buildFrictionEntry,
  extractLastErrorLine,
  getDefaultFrictionLogPath,
  getFrictionLogPath,
} from '../../src/util/friction-log.js'

describe('friction-log utils', () => {
  describe('getFrictionLogPath', () => {
    it('returns null when env var is undefined', () => {
      expect(getFrictionLogPath()).to.equal(null)
    })

    it('returns null for empty string', () => {
      expect(getFrictionLogPath('')).to.equal(null)
    })

    it('returns null for "false"', () => {
      expect(getFrictionLogPath('false')).to.equal(null)
    })

    it('returns null for "0"', () => {
      expect(getFrictionLogPath('0')).to.equal(null)
    })

    it('returns default ~/.qfg/friction.log path for "true"', () => {
      expect(getFrictionLogPath('true', '/tmp/work')).to.equal(getDefaultFrictionLogPath())
    })

    it('returns default ~/.qfg/friction.log path for "1"', () => {
      expect(getFrictionLogPath('1', '/tmp/work')).to.equal(getDefaultFrictionLogPath())
    })

    it('default path is under the home dir, not cwd', () => {
      const defaultPath = getDefaultFrictionLogPath('/home/me')
      expect(defaultPath).to.equal(path.join('/home/me', '.qfg', 'friction.log'))
    })

    it('returns absolute path unchanged', () => {
      expect(getFrictionLogPath('/var/log/qfg.log')).to.equal('/var/log/qfg.log')
    })

    it('resolves relative path against cwd', () => {
      // Use an absolute cwd built with the platform's own separator so the
      // expected value matches on Windows too (path.resolve there would
      // prepend a drive letter and use backslashes).
      const cwd = path.resolve(path.sep, 'home', 'me')
      expect(getFrictionLogPath('logs/qfg.log', cwd)).to.equal(path.join(cwd, 'logs', 'qfg.log'))
    })

    it('trims whitespace from the value', () => {
      expect(getFrictionLogPath('  true  ', '/tmp')).to.equal(getDefaultFrictionLogPath())
    })
  })

  describe('buildFrictionEntry', () => {
    const now = new Date('2026-04-17T12:34:56.789Z')

    it('includes ts, attempted, error, exitCode', () => {
      const entry = buildFrictionEntry({
        argv: ['flag', 'show', 'build.dark-mode'],
        error: 'command not found',
        exitCode: 2,
        now,
      })
      expect(entry).to.deep.equal({
        attempted: 'qfg flag show build.dark-mode',
        error: 'command not found',
        exitCode: 2,
        ts: '2026-04-17T12:34:56.789Z',
      })
    })

    it('falls back to synthesized error when none provided', () => {
      const entry = buildFrictionEntry({argv: ['get', 'x'], exitCode: 2, now})
      expect(entry.error).to.equal('nonzero exit code 2')
    })

    it('falls back to synthesized error when provided error is whitespace-only', () => {
      const entry = buildFrictionEntry({argv: ['get', 'x'], error: '   \n', exitCode: 1, now})
      expect(entry.error).to.equal('nonzero exit code 1')
    })

    it('supports custom bin name', () => {
      const entry = buildFrictionEntry({argv: ['help'], binName: 'qf', exitCode: 1, now})
      expect(entry.attempted).to.equal('qf help')
    })
  })

  describe('extractLastErrorLine', () => {
    it('returns undefined for empty input', () => {
      expect(extractLastErrorLine('')).to.equal(undefined)
    })

    it('finds an "Error:" line', () => {
      expect(extractLastErrorLine('doing stuff\nError: key does not exist\n')).to.equal('key does not exist')
    })

    it('strips ansi escape codes', () => {
      expect(extractLastErrorLine('\u001B[31mError: boom\u001B[0m\n')).to.equal('boom')
    })

    it('falls back to last line when no error marker', () => {
      expect(extractLastErrorLine('warn: thing\nsomething went wrong\n')).to.equal('something went wrong')
    })

    it('finds an oclif » marker line', () => {
      expect(extractLastErrorLine('» Error: bad flag')).to.equal('bad flag')
    })
  })

  describe('appendFrictionEntry', () => {
    let tmpdir: string
    let logPath: string

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-log-test-'))
      logPath = path.join(tmpdir, 'nested', 'friction.log')
    })

    afterEach(() => {
      fs.rmSync(tmpdir, {force: true, recursive: true})
    })

    it('creates parent dirs and writes one JSON object per line, appending across calls', () => {
      appendFrictionEntry(logPath, {
        attempted: 'qfg flag show x',
        error: 'command not found',
        exitCode: 2,
        ts: '2026-04-17T00:00:00.000Z',
      })
      appendFrictionEntry(logPath, {
        attempted: 'qfg get y',
        error: 'y does not exist',
        exitCode: 1,
        ts: '2026-04-17T00:00:01.000Z',
      })

      const raw = fs.readFileSync(logPath, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      expect(lines).to.have.length(2)
      expect(JSON.parse(lines[0])).to.deep.equal({
        attempted: 'qfg flag show x',
        error: 'command not found',
        exitCode: 2,
        ts: '2026-04-17T00:00:00.000Z',
      })
      expect(JSON.parse(lines[1]).attempted).to.equal('qfg get y')
    })
  })
})
