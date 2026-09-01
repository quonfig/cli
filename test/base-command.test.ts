import {Errors} from '@oclif/core'
import {expect} from 'chai'

import {errorExitCode, processExitCode} from '../src/index.js'

// qfg-hzmb: BaseCommand.catch() used to terminate with `err.exitCode || 1`.
// Nothing oclif throws carries an `exitCode` property, so every deliberate
// non-default exit code silently degraded to 1.
describe('errorExitCode', () => {
  it('reads the code oclif recorded for this.error(msg, {exit: 401})', () => {
    const err = new Errors.CLIError('Not logged in. Run `qfg login` first.', {exit: 401})

    // The property the old code read does not exist — this is the bug.
    expect((err as {exitCode?: number}).exitCode).to.equal(undefined)
    expect(err.oclif.exit).to.equal(401)

    expect(errorExitCode(err)).to.equal(401)
  })

  it('preserves the code carried by an ExitError from this.exit(n)', () => {
    expect(errorExitCode(new Errors.ExitError(3))).to.equal(3)
  })

  it('honours an explicit exitCode property when there is no oclif block', () => {
    expect(errorExitCode(Object.assign(new Error('boom'), {exitCode: 7}))).to.equal(7)
  })

  it('falls back to 1 for a plain Error, a bare object, and nothing at all', () => {
    expect(errorExitCode(new Error('boom'))).to.equal(1)
    expect(errorExitCode({message: 'boom'})).to.equal(1)
    expect(errorExitCode(null)).to.equal(1)
  })
})

describe('processExitCode', () => {
  it('passes through codes that fit in a POSIX exit status', () => {
    expect(processExitCode(new Errors.ExitError(1))).to.equal(1)
    expect(processExitCode(new Errors.ExitError(2))).to.equal(2)
    expect(processExitCode(new Errors.CLIError('nope', {exit: 255}))).to.equal(255)
  })

  it('does not truncate an HTTP-flavoured code into signal territory', () => {
    // process.exit(401) truncates to 145, which a shell reads as
    // "killed by signal 17". Terminate with the plain failure code instead;
    // the real 401 is still reported as error.exitCode in the JSON envelope.
    const err = new Errors.CLIError('No authentication found. Please run `qfg login`.', {exit: 401})
    expect(errorExitCode(err)).to.equal(401)
    expect(processExitCode(err)).to.equal(1)
  })
})
