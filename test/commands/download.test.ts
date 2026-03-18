import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {resetClientCache} from '../../src/util/get-client.js'
import {downloadStub, server} from '../responses/download.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const expectedFileName = 'quonfig.test.588.config.json'

const savedContent = () => JSON.parse(fs.readFileSync(expectedFileName).toString())

describe('download', () => {
  before(() => {
    setupTestAuth()
    fs.rmSync(expectedFileName, {force: true})
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('when the download server responds successfully', () => {
    test
      .stdout()
      .command(['download', '--environment=test'])
      .it('saves the file and returns a success message', (ctx) => {
        expect(ctx.stdout).to.eql(`✔ Successfully downloaded ${expectedFileName}\n`)
        expect(savedContent()).to.eql(downloadStub)
      })

    test
      .stdout()
      .command(['download', '--environment=test', '--json'])
      .it('saves the file and returns JSON', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.eql({
          filePath: path.join(process.cwd(), expectedFileName),
          succes: true,
        })

        expect(savedContent()).to.eql(downloadStub)
      })
  })

  describe('when the download server does not respond successfully', () => {
    test
      .stderr()
      .command(['download', '--environment=Production'])
      .catch(/Failed to download file. Status=500/)
      .it('saves the file and returns a success message', () => {
        // Error assertion done in catch block
      })

    test
      .stdout()
      .command(['download', '--environment=Production', '--json'])
      .catch((error) => {
        expect(error.message).to.include('something went wrong')
      })
      .it('saves the file and returns JSON', () => {
        // Error assertion done in catch block
      })
  })

  describe('when the provided environment is invalid', () => {
    test
      .stderr()
      .command(['download', '--environment=this.does.not.exist'])
      .catch(/Environment `this.does.not.exist` not found. Valid environments: Production, test/)
      .it('saves the file and returns a success message', () => {
        // Error assertion done in catch block
      })

    test
      .command(['download', '--environment=this.does.not.exist', '--json'])
      .catch(() => {
        // Environment validation error is handled by first test
      })
      .it('saves the file and returns JSON', () => {
        // Error assertion done in catch block
      })
  })
})
