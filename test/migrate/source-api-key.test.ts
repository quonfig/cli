import {expect} from 'chai'

import {PROVIDER_API_KEY_ENV, resolveSourceApiKey} from '../../src/migrate/source-api-key.js'

/**
 * Decision D8 (project/plans/migrator-launch-darkly.md §9.1): the migrate
 * command's API-key flag is generalized from the launch-specific `--api-key` /
 * `LAUNCH_API_KEY` to a provider-agnostic `--source-api-key` /
 * `QUONFIG_MIGRATE_API_KEY`, with a per-provider env fallback. `--api-key` /
 * `LAUNCH_API_KEY` stay as deprecated aliases.
 */
describe('migrate/source-api-key — D8 generalized key resolution', () => {
  it('prefers the explicit --source-api-key flag over everything else', () => {
    expect(
      resolveSourceApiKey({
        apiKeyFlag: 'old',
        env: {LAUNCHDARKLY_API_KEY: 'env'},
        from: 'launchdarkly',
        sourceApiKeyFlag: 'new',
      }),
    ).to.equal('new')
  })

  it('falls back to the deprecated --api-key flag when --source-api-key is absent', () => {
    expect(resolveSourceApiKey({apiKeyFlag: 'old', env: {}, from: 'launch'})).to.equal('old')
  })

  it('falls back to the per-provider env var for launchdarkly (LAUNCHDARKLY_API_KEY)', () => {
    expect(resolveSourceApiKey({env: {LAUNCHDARKLY_API_KEY: 'ld-env'}, from: 'launchdarkly'})).to.equal('ld-env')
  })

  it("does not use one provider's env var for a different provider", () => {
    expect(resolveSourceApiKey({env: {LAUNCHDARKLY_API_KEY: 'ld-env'}, from: 'flagsmith'})).to.equal(undefined)
  })

  it('returns undefined when no key is configured anywhere', () => {
    expect(resolveSourceApiKey({env: {}, from: 'launchdarkly'})).to.equal(undefined)
  })

  it('maps every supported --from value to a per-provider env var', () => {
    expect(Object.keys(PROVIDER_API_KEY_ENV).sort()).to.deep.equal(['flagsmith', 'launch', 'launchdarkly'])
  })
})
