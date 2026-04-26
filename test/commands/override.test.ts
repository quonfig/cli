import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('override', () => {
  before(() => {
    setupTestAuth()
  })
  afterEach(() => {
    resetClientCache()
  })
  after(() => {
    cleanupTestAuth()
  })

  test
    .stderr()
    .command(['override', 'feature-flag.simple', '--value=true', '--environment=Development'])
    .catch((error) => {
      expect(error.message).to.contain('not yet implemented')
      expect(error.message).to.contain('project/plans/dev-overrides.md')
    })
    .it('exits with not-yet-implemented message pointing at the dev-overrides plan', () => {
      // assertion in catch
    })

  test
    .stderr()
    .command(['override'])
    .catch((error) => {
      expect(error.message).to.contain('not yet implemented')
    })
    .it('exits with not-yet-implemented message when called with no args', () => {
      // assertion in catch
    })

  test
    .stderr()
    .command(['override', 'feature-flag.simple', '--remove'])
    .catch((error) => {
      expect(error.message).to.contain('not yet implemented')
    })
    .it('exits with not-yet-implemented message for --remove', () => {
      // assertion in catch
    })

  test
    .stderr()
    .command(['override', 'feature-flag.simple', '--value=true'])
    .catch((error) => {
      // The stub must not call the dead Prefab endpoints; if any HTTP went out we'd
      // see network/auth errors instead of the not-yet-implemented message.
      expect(error.message).to.not.contain('/internal/ops/v1/assign-variant')
      expect(error.message).to.not.contain('/internal/ops/v1/remove-variant')
      expect(error.message).to.not.contain('Failed to fetch configs')
    })
    .it('does not call the legacy /internal/ops/v1/* endpoints', () => {
      // assertion in catch
    })
})
