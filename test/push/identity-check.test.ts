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
  remoteOriginUrl: 'https://git.quonfig.com/acme-prod/config',
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

    it('returns ok when pin matches, origin is missing, and requested matches', () => {
      const result = checkIdentity(
        baseInput({
          remoteOriginUrl: undefined,
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when pin is missing, origin matches, and requested matches', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: undefined,
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when origin URL has a .git suffix', () => {
      const result = checkIdentity(
        baseInput({
          remoteOriginUrl: 'https://git.quonfig.com/acme-prod/config.git',
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when origin URL has a basic-auth prefix', () => {
      const result = checkIdentity(
        baseInput({
          remoteOriginUrl: 'https://someuser:sometoken@git.quonfig.com/acme-prod/config',
        }),
      )
      expect(result.kind).to.equal('ok')
    })

    it('returns ok when origin URL has basic-auth AND .git suffix AND trailing slash AND uppercased host', () => {
      const result = checkIdentity(
        baseInput({
          remoteOriginUrl: 'https://user:pw@GIT.QUONFIG.COM/acme-prod/config.git/',
        }),
      )
      expect(result.kind).to.equal('ok')
    })
  })

  describe('requires-typed-slug outcomes', () => {
    it('requires typed slug when pin and origin are both missing', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: undefined,
          remoteOriginUrl: undefined,
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
          remoteOriginUrl: undefined,
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/pin|requested/)
        expect(result.details).to.be.an('object')
      }
    })

    it('aborts when origin URL points to a different repo than backend.repoUrl', () => {
      const result = checkIdentity(
        baseInput({
          remoteOriginUrl: 'https://git.quonfig.com/someone-else/config',
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/origin/)
      }
    })

    it('aborts when pin matches backend but origin URL points elsewhere', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: 'acme-prod',
          requestedTarget: 'acme-prod',
          remoteOriginUrl: 'https://git.quonfig.com/other/config',
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/origin/)
      }
    })

    it('aborts when pin is present but does not match the backend', () => {
      const result = checkIdentity(
        baseInput({
          repoPinSlug: 'wrong-ws',
          requestedTarget: 'wrong-ws',
          remoteOriginUrl: undefined,
        }),
      )
      expect(result.kind).to.equal('abort')
    })

    it('aborts on malformed origin URL (safer path — we do not silently ignore unknown remote)', () => {
      // Judgment call: a malformed origin URL is a mismatch signal we cannot resolve.
      // Safer to abort than to treat it as "missing" (which could auto-proceed with just the pin).
      const result = checkIdentity(
        baseInput({
          remoteOriginUrl: 'not a url at all ::::',
        }),
      )
      expect(result.kind).to.equal('abort')
      if (result.kind === 'abort') {
        expect(result.reason.toLowerCase()).to.match(/origin/)
      }
    })
  })

  describe('programming-error guards', () => {
    it('throws when requestedTarget is empty (required input)', () => {
      expect(() =>
        checkIdentity({
          requestedTarget: '',
          repoPinSlug: 'acme-prod',
          remoteOriginUrl: undefined,
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
          remoteOriginUrl: undefined,
        }),
      )
      expect(result.kind).to.equal('abort')
    })
  })
})
