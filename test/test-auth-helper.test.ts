import {expect} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {cleanupTestAuth, setupTestAuth} from './test-auth-helper.js'

describe('test-auth-helper', () => {
  let prevConfigHome: string | undefined

  beforeEach(() => {
    prevConfigHome = process.env.QUONFIG_CONFIG_HOME
    delete process.env.QUONFIG_CONFIG_HOME
  })

  afterEach(() => {
    if (prevConfigHome === undefined) {
      delete process.env.QUONFIG_CONFIG_HOME
    } else {
      process.env.QUONFIG_CONFIG_HOME = prevConfigHome
    }
  })

  it('writes fixtures into a tmp dir, never the user home', () => {
    const {configFile, tokensFile} = setupTestAuth()

    const homeQuonfig = path.join(os.homedir(), '.quonfig')
    expect(tokensFile.startsWith(homeQuonfig)).to.equal(false)
    expect(configFile.startsWith(homeQuonfig)).to.equal(false)
    expect(tokensFile.startsWith(os.tmpdir())).to.equal(true)
    expect(fs.existsSync(tokensFile)).to.equal(true)
    expect(fs.existsSync(configFile)).to.equal(true)

    cleanupTestAuth()
  })

  it('points QUONFIG_CONFIG_HOME at the tmp dir while active', () => {
    const {tokensFile} = setupTestAuth()

    expect(process.env.QUONFIG_CONFIG_HOME).to.equal(path.dirname(tokensFile))

    cleanupTestAuth()
  })

  it('rm-rfs the tmp dir on cleanup', () => {
    const {tokensFile} = setupTestAuth()
    const tmpDir = path.dirname(tokensFile)
    expect(fs.existsSync(tmpDir)).to.equal(true)

    cleanupTestAuth()

    expect(fs.existsSync(tmpDir)).to.equal(false)
  })

  it('restores a previously-set QUONFIG_CONFIG_HOME on cleanup', () => {
    process.env.QUONFIG_CONFIG_HOME = '/some/preset/value'

    setupTestAuth()
    expect(process.env.QUONFIG_CONFIG_HOME).to.not.equal('/some/preset/value')

    cleanupTestAuth()
    expect(process.env.QUONFIG_CONFIG_HOME).to.equal('/some/preset/value')
  })

  it('unsets QUONFIG_CONFIG_HOME on cleanup when it was unset before', () => {
    setupTestAuth()
    cleanupTestAuth()

    expect(process.env.QUONFIG_CONFIG_HOME).to.equal(undefined)
  })
})
