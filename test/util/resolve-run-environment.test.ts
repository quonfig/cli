import {expect} from '@oclif/test'
import {describe, it} from 'mocha'

import {
  RUN_MODE_AMBIGUOUS_ERROR,
  RUN_MODE_NO_ENV_ERROR,
  resolveRunEnvironmentMode,
} from '../../src/util/resolve-run-environment.js'

/**
 * The mode rule for `qfg run` is **binary and mutually exclusive**:
 *
 * Mode A — `QUONFIG_BACKEND_SDK_KEY` set: env is encoded in the key. If
 *          `--environment` OR `QUONFIG_ENVIRONMENT` is also present → error,
 *          even if they would agree.
 *
 * Mode B — no SDK key: require EXACTLY ONE of `--environment` flag or
 *          `QUONFIG_ENVIRONMENT` env var. Both → error. Neither → error.
 *
 * The function NEVER prompts and NEVER falls back. Errors are returned as
 * discriminated-union variants so the caller decides how to surface them.
 */
describe('resolveRunEnvironmentMode', () => {
  describe('Mode A — SDK key set', () => {
    it('returns sdk-key mode when only QUONFIG_BACKEND_SDK_KEY is set', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: 'qfk-abcdef-1234',
        envFlag: undefined,
        envFromEnvironment: undefined,
      })
      expect(result).to.deep.equal({mode: 'sdk-key', sdkKey: 'qfk-abcdef-1234'})
    })

    it('errors when SDK key + --environment flag are both set (even if they would agree)', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: 'qfk-abcdef-1234',
        envFlag: 'production',
        envFromEnvironment: undefined,
      })
      expect(result.mode).to.equal('error')
      if (result.mode !== 'error') return
      expect(result.message).to.equal(RUN_MODE_AMBIGUOUS_ERROR)
    })

    it('errors when SDK key + QUONFIG_ENVIRONMENT are both set (even if they would agree)', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: 'qfk-abcdef-1234',
        envFlag: undefined,
        envFromEnvironment: 'production',
      })
      expect(result.mode).to.equal('error')
      if (result.mode !== 'error') return
      expect(result.message).to.equal(RUN_MODE_AMBIGUOUS_ERROR)
    })

    it('errors when SDK key + flag + env var are all set', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: 'qfk-abcdef-1234',
        envFlag: 'production',
        envFromEnvironment: 'production',
      })
      expect(result.mode).to.equal('error')
      if (result.mode !== 'error') return
      expect(result.message).to.equal(RUN_MODE_AMBIGUOUS_ERROR)
    })
  })

  describe('Mode B — user auth', () => {
    it('returns user mode when only --environment flag is set', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: undefined,
        envFlag: 'staging',
        envFromEnvironment: undefined,
      })
      expect(result).to.deep.equal({mode: 'user', environmentName: 'staging'})
    })

    it('returns user mode when only QUONFIG_ENVIRONMENT is set', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: undefined,
        envFlag: undefined,
        envFromEnvironment: 'staging',
      })
      expect(result).to.deep.equal({mode: 'user', environmentName: 'staging'})
    })

    it('errors when neither flag nor env var is set', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: undefined,
        envFlag: undefined,
        envFromEnvironment: undefined,
      })
      expect(result.mode).to.equal('error')
      if (result.mode !== 'error') return
      expect(result.message).to.equal(RUN_MODE_NO_ENV_ERROR)
    })

    it('errors when both --environment flag and QUONFIG_ENVIRONMENT are set', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: undefined,
        envFlag: 'staging',
        envFromEnvironment: 'production',
      })
      expect(result.mode).to.equal('error')
      if (result.mode !== 'error') return
      // The "both set" case in Mode B is also an ambiguity error; the
      // message must be specific so users know which knob to remove.
      expect(result.message).to.contain('exactly one')
    })
  })

  describe('error messages name the fix verbatim', () => {
    it('Mode A error message names QUONFIG_BACKEND_SDK_KEY and the two knobs to remove', () => {
      expect(RUN_MODE_AMBIGUOUS_ERROR).to.contain('QUONFIG_BACKEND_SDK_KEY')
      expect(RUN_MODE_AMBIGUOUS_ERROR).to.contain('--environment')
      expect(RUN_MODE_AMBIGUOUS_ERROR).to.contain('QUONFIG_ENVIRONMENT')
    })

    it('Mode B no-env message names QUONFIG_BACKEND_SDK_KEY, QUONFIG_ENVIRONMENT, and --environment', () => {
      expect(RUN_MODE_NO_ENV_ERROR).to.contain('QUONFIG_BACKEND_SDK_KEY')
      expect(RUN_MODE_NO_ENV_ERROR).to.contain('QUONFIG_ENVIRONMENT')
      expect(RUN_MODE_NO_ENV_ERROR).to.contain('--environment')
    })
  })

  describe('empty strings are treated as unset', () => {
    // Bash exporters routinely emit `QUONFIG_BACKEND_SDK_KEY=` when a var is
    // declared but empty; we should treat that the same as "unset" rather
    // than silently picking Mode A with an empty key.
    it('empty SDK key + flag → user mode', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: '',
        envFlag: 'staging',
        envFromEnvironment: undefined,
      })
      expect(result).to.deep.equal({mode: 'user', environmentName: 'staging'})
    })

    it('empty flag + env var → user mode using env var', () => {
      const result = resolveRunEnvironmentMode({
        sdkKey: undefined,
        envFlag: '',
        envFromEnvironment: 'staging',
      })
      expect(result).to.deep.equal({mode: 'user', environmentName: 'staging'})
    })
  })
})
