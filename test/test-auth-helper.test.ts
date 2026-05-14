import {expect} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {loadTokens, TOKEN_STORE_VERSION} from '../src/util/token-storage.js'
import {cleanupTestAuth, disableAuth, setupTestAuth} from './test-auth-helper.js'

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

  describe('disableAuth', () => {
    let fakeRealHome: string | undefined

    afterEach(() => {
      if (fakeRealHome) {
        fs.rmSync(fakeRealHome, {force: true, recursive: true})
        fakeRealHome = undefined
      }
    })

    it('makes loadTokens return null even when an outer QUONFIG_CONFIG_HOME has real tokens', async () => {
      // Simulate a developer machine where the original QUONFIG_CONFIG_HOME
      // (or its ~/.quonfig/ fallback) holds real tokens. This is the leak
      // path that breaks the "not logged in" tests locally: cleanupTestAuth()
      // restores the original env, so loadTokens() then reads the dev's real
      // tokens.
      fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-fakehome-'))
      const tokensFilename = process.env.QUONFIG_DOMAIN
        ? `tokens-${process.env.QUONFIG_DOMAIN.replaceAll('.', '-')}.json`
        : 'tokens.json'
      fs.writeFileSync(
        path.join(fakeRealHome, tokensFilename),
        JSON.stringify({
          tokensByOrg: {
            org_real: {
              access_token: 'real-token',
              expires_at: Date.now() + 3_600_000,
              refresh_token: 'real-refresh',
            },
          },
          version: TOKEN_STORE_VERSION,
        }),
      )
      process.env.QUONFIG_CONFIG_HOME = fakeRealHome

      const before = await loadTokens()
      expect(before, 'sanity: real tokens visible at outer QUONFIG_CONFIG_HOME').to.not.equal(null)

      disableAuth()

      const after = await loadTokens()
      expect(after, 'after disableAuth, loadTokens must return null').to.equal(null)
    })
  })
})
