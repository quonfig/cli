import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/list.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const exampleFF = 'feature-flag.integer'
const exampleLL = 'log-level.reforge.views.index'
const exampleSegment = 'segment-with-and-conditions'
const exampleConfig = 'my-string-list-key'

describe('list', () => {
  before(() => {
    setupTestAuth()
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
  test
    .stdout()
    .command(['list'])
    .it('lists everything by default', (ctx) => {
      // Check that the keys appear in the tabular output
      expect(ctx.stdout).to.contain(exampleSegment)
      expect(ctx.stdout).to.contain(exampleLL)
      expect(ctx.stdout).to.contain(exampleFF)
      expect(ctx.stdout).to.contain(exampleConfig)
    })

  test
    .stdout()
    .command(['list', '--feature-flags'])
    .it('lists only flags', (ctx) => {
      expect(ctx.stdout).to.contain(exampleFF)
      expect(ctx.stdout).to.not.contain(exampleLL)
      expect(ctx.stdout).to.not.contain(exampleSegment)
      expect(ctx.stdout).to.not.contain(exampleConfig)
    })

  test
    .stdout()
    .command(['list', '--configs'])
    .it('lists only configs', (ctx) => {
      expect(ctx.stdout).to.not.contain(exampleFF)
      expect(ctx.stdout).to.not.contain(exampleLL)
      expect(ctx.stdout).to.not.contain(exampleSegment)
      expect(ctx.stdout).to.contain(exampleConfig)
    })

  test
    .stdout()
    .command(['list', '--log-levels'])
    .it('lists only log levels', (ctx) => {
      expect(ctx.stdout).to.not.contain(exampleFF)
      expect(ctx.stdout).to.contain(exampleLL)
      expect(ctx.stdout).to.not.contain(exampleSegment)
      expect(ctx.stdout).to.not.contain(exampleConfig)
    })

  test
    .stdout()
    .command(['list', '--segments'])
    .it('lists only segments', (ctx) => {
      expect(ctx.stdout).to.not.contain(exampleFF)
      expect(ctx.stdout).to.not.contain(exampleLL)
      expect(ctx.stdout).to.contain(exampleSegment)
      expect(ctx.stdout).to.not.contain(exampleConfig)
    })

  test
    .stdout()
    .command(['list', '--feature-flags', '--configs'])
    .it('lists multiple types', (ctx) => {
      expect(ctx.stdout).to.contain(exampleFF)
      expect(ctx.stdout).to.not.contain(exampleLL)
      expect(ctx.stdout).to.not.contain(exampleSegment)
      expect(ctx.stdout).to.contain(exampleConfig)
    })
})
