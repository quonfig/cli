import {expect} from 'chai'

import isInteractive from '../../src/util/is-interactive.js'

describe('isInteractive', () => {
  // Save and restore the real TTY values so our fiddling doesn't leak into other tests.
  const originalStdinTTY = process.stdin.isTTY
  const originalStdoutTTY = process.stdout.isTTY

  const setTTY = (stdin: boolean, stdout: boolean) => {
    Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: stdin})
    Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: stdout})
  }

  afterEach(() => {
    setTTY(originalStdinTTY as boolean, originalStdoutTTY as boolean)
  })

  describe('when --no-interactive was passed', () => {
    it('returns false regardless of TTY', () => {
      setTTY(true, true)
      expect(isInteractive({interactive: false})).to.equal(false)

      setTTY(false, false)
      expect(isInteractive({interactive: false})).to.equal(false)
    })
  })

  describe('when the interactive flag is not explicitly disabled', () => {
    // This is the bug-fix case: historically isInteractive would return true
    // whenever flags.interactive was truthy (the default), which bypassed the
    // TTY check entirely. That caused qfg create / qfg set-default to hang
    // under non-TTY stdio (CI, piped stdin, nohup) because the prompt helpers
    // would be invoked with no way to read stdin, leaving an unsettled
    // top-level await.
    it('returns false when stdin is not a TTY (auto-detect)', () => {
      setTTY(false, true)
      expect(isInteractive({interactive: true})).to.equal(false)
      expect(isInteractive({})).to.equal(false)
    })

    it('returns false when stdout is not a TTY (auto-detect)', () => {
      setTTY(true, false)
      expect(isInteractive({interactive: true})).to.equal(false)
      expect(isInteractive({})).to.equal(false)
    })

    it('returns true when both stdin and stdout are TTY', () => {
      setTTY(true, true)
      expect(isInteractive({interactive: true})).to.equal(true)
      expect(isInteractive({})).to.equal(true)
    })
  })
})
