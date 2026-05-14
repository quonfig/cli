import {expect} from 'chai'

import {checkIdentity, IdentityCheckInput} from '../../src/push/identity-check.js'

const BACKEND = {
  workspaceSlug: 'acme-prod',
  workspaceId: '11111111-2222-3333-4444-555555555555',
  repoUrl: 'https://git.quonfig.com/acme-prod/config',
}

const baseInput = (overrides: Partial<IdentityCheckInput> = {}): IdentityCheckInput => ({
  requestedTarget: 'acme-prod',
  repoPinSlug: 'acme-prod',
  remoteUrls: ['https://git.quonfig.com/acme-prod/config'],
  backend: BACKEND,
  ...overrides,
})

describe('checkIdentity (Guards 1 + 2)', () => {
  describe('ok outcomes', () => {
    it('returns ok when all three sources match the backend slug', () => {
      const result = checkIdentity(baseInput())
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.canonicalSlug).to.equal('acme-prod')
      }
    })

    it('returns ok when pin matches, origin matches, and requested is the UUID (not slug)', () => {
      const result = checkIdentity(
        baseInput({
          requestedTarget: BACKEND.workspaceId,
        }),
      )
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.canonicalSlug).to.equal('acme-prod')
      }
    })

    it('returns ok when pin matches, no git remotes, and requested matches', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: [],
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when pin is missing, single remote matches, and requested matches', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: undefined,
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when remote URL has a .git suffix', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['https://git.quonfig.com/acme-prod/config.git'],
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when remote URL has a basic-auth prefix', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['https://someuser:sometoken@git.quonfig.com/acme-prod/config'],
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when remote URL has basic-auth AND .git suffix AND trailing slash AND uppercased host', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['https://user:pw@GIT.QUONFIG.COM/acme-prod/config.git/'],
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    /**
     * Multi-remote support (qfg-glrd.3). Customers often use GitHub for PR
     * review (origin = github.com/their-org/configs) and have a secondary
     * remote pointing at their Quonfig repo. The identity check accepts as
     * long as *any* configured remote matches the backend.
     */
    it('returns ok when ONE of several remotes matches the backend (github + quonfig case)', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['https://github.com/acme-corp/configs.git', 'https://git.quonfig.com/acme-prod/config'],
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when the matching remote is third in the list (order-insensitive)', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: [
            'https://gitlab.com/acme/configs.git',
            'https://bitbucket.org/acme/configs.git',
            'https://git.quonfig.com/acme-prod/config',
          ],
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when a malformed entry sits alongside a matching remote (best-effort, tolerates noise)', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['not a url at all', 'https://git.quonfig.com/acme-prod/config'],
        }),
      )
      expect(result.kind).to.equal('ok')
    })
  })

  describe('requires-typed-slug outcomes', () => {
    it('requires typed slug when pin is missing and no remotes are configured', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: undefined,
          remoteUrls: [],
        }),
      )
      expect(result.kind).to.equal('requires-typed-slug-confirmation')
      if (result.kind === 'requires-typed-slug-confirmation') {
        expect(result.canonicalSlug).to.equal('acme-prod')
        expect(result.reason).to.be.a('string').and.not.empty
      }
    })
  })

  describe('abort outcomes', () => {
    it('aborts when pin and requested disagree', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: 'acme-prod',
          requestedTarget: 'other-ws',
          remoteUrls: [],
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/pin|requested/)
        expect(result.details).to.be.an('object')
      }
    })

    it('aborts when the single configured remote points to a different repo than backend.repoUrl', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['https://git.quonfig.com/someone-else/config'],
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/remote/)
      }
    })

    it('aborts when pin matches backend but the remote points elsewhere', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: 'acme-prod',
          requestedTarget: 'acme-prod',
          remoteUrls: ['https://git.quonfig.com/other/config'],
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/remote/)
      }
    })

    it('aborts when pin is present but does not match the backend', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: 'wrong-ws',
          requestedTarget: 'wrong-ws',
          remoteUrls: [],
        }),
      )
      expect(result.kind).to.equal('abort')
    })

    /**
     * Multi-remote abort: every configured remote points somewhere other than
     * the backend. Surface ALL of them in the abort details so the user can
     * see which remotes were considered.
     */
    it('aborts when multiple remotes are configured but none match the backend', () => {
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['https://github.com/acme-corp/configs.git', 'https://git.quonfig.com/other-ws/config'],
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/remote/)
        // The abort surface includes every remote that was considered so the
        // user can debug which remote is mistargeted.
        expect(result.details.remoteUrls).to.include('https://github.com/acme-corp/configs.git')
        expect(result.details.remoteUrls).to.include('https://git.quonfig.com/other-ws/config')
      }
    })

    it('aborts when the only configured remote is a malformed URL', () => {
      // Judgment call: a single malformed remote with no other signal is a
      // mismatch we cannot resolve. Safer to abort than to silently ignore.
      const result = checkIdentity(
        baseInput({
          remoteUrls: ['not a url at all ::::'],
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/remote/)
      }
    })
  })

  describe('programming-error guards', () => {
    it('throws when requestedTarget is empty (required input)', () => {
      expect(() =>
        checkIdentity({
          requestedTarget: '',
          repoPinSlug: 'acme-prod',
          remoteUrls: [],
          backend: BACKEND,
        }),
      ).to.throw(/requestedTarget/)
    })
  })

  /**
   * Regression matrix for qfg-gmg — verify that when backend.workspaceId is
   * the canonical UUID (not the slug), both `--workspace <slug>` and
   * `--workspace <UUID>` are accepted as "requested matches backend". This
   * was broken when buildRealDeps was still setting backend.workspaceId to
   * the slug — `--workspace <UUID>` aborted with a requested-mismatch.
   */
  describe('qfg-gmg regression — slug vs UUID requested targets', () => {
    const BACKEND_UUID = BACKEND.workspaceId
    const BACKEND_SLUG = BACKEND.workspaceSlug

    it('ok when requested is the slug and backend.workspaceId is the UUID (staging shape)', () => {
      const result = checkIdentity(
        baseInput({
          requestedTarget: BACKEND_SLUG,
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('ok when requested is the UUID and backend.workspaceId is the UUID (staging shape)', () => {
      const result = checkIdentity(
        baseInput({
          requestedTarget: BACKEND_UUID,
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('aborts when requested is an unrelated UUID', () => {
      const result = checkIdentity(
        baseInput({
          requestedTarget: '99999999-9999-9999-9999-999999999999',
          repoPinSlug: undefined,
          remoteUrls: [],
        }),
      )
      expect(result.kind).to.equal('abort')
    })
  })
})
