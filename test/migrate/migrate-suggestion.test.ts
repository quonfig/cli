import {expect} from 'chai'

import {buildPushConflictSuggestion} from '../../src/migrate/migrate-suggestion.js'

describe('migrate/migrate-suggestion', () => {
  describe('buildPushConflictSuggestion', () => {
    it('uses the user-supplied org/slug verbatim, not the resolved UUID', () => {
      const suggestion = buildPushConflictSuggestion({
        from: 'launch',
        userWorkspaceFlag: 'test-organization/semgrep-test-1',
      })

      expect(suggestion).to.equal(
        'Re-run `qfg migrate --from launch --workspace test-organization/semgrep-test-1 --push` to pick up remote changes before retrying.',
      )
      expect(suggestion).to.not.match(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/i)
    })

    it('omits --workspace when the user did not pass --workspace (saved-profile fallback)', () => {
      const suggestion = buildPushConflictSuggestion({
        from: 'launch',
        userWorkspaceFlag: undefined,
      })

      expect(suggestion).to.equal(
        'Re-run `qfg migrate --from launch --push` to pick up remote changes before retrying.',
      )
    })
  })
})
