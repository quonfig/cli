/**
 * qfg-5bjew.17 (T12): a 403 from set-default printed only
 * "Failed to change default: 403". Print the server's message too. The
 * --json serverError payload and other commands' 403 text are unchanged.
 */

import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/set-default.js'
import {getApiBase} from '../test-domain-helper.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const SERVER_MESSAGE = 'Environment "Development" is protected; editing its rules requires config.edit.protected.'

describe('set-default 403 (qfg-5bjew.17)', () => {
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

  const forbidden = (body: any) => () =>
    server.use(http.post(`${getApiBase()}/api/v1/flags/update`, () => HttpResponse.json(body, {status: 403})))

  test
    .add('forbidden', forbidden({json: {code: 'FORBIDDEN', status: 403, message: SERVER_MESSAGE}}))
    .stdout()
    .stderr()
    .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
    .catch((error) => {
      expect(error.message).to.equal(`Failed to change default: 403: ${SERVER_MESSAGE}`)
    })
    .it('prints the server message after the status')

  test
    .add('forbidden', forbidden('not json'))
    .stdout()
    .stderr()
    .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
    .catch((error) => {
      expect(error.message).to.equal('Failed to change default: 403')
    })
    .it('keeps the old text when the body has no message')
})
