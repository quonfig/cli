import {expect} from 'chai'
import * as fs from 'node:fs'

import type Push from '../../src/commands/push.js'

import {REFERENCE} from '../../src/commands/config-schema.js'
import {buildRealDeps} from '../../src/commands/push.js'
import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {buildRules, type RulesetContext} from '../../src/migrate/quonfig-target/ruleset.js'
import {REGEX_V1_DOCS_URL} from '../../src/verify/regex-dialect.js'
import {validateFileMap, validateWorkspace} from '../../src/verify/validate.js'
import {cleanFiles, flag, plantedFiles, regex, writeWorkspace} from './regex-fixtures.js'

/**
 * qfg-ktkr.2: every cli writer refuses a PROP_MATCHES / PROP_DOES_NOT_MATCH
 * pattern outside Quonfig regex v1. One call site (validate.ts) covers
 * `qfg verify` + the Git hook (validateWorkspace / validateFileMap) and both
 * push engines (`qfg push` deps.validate, `qfg migrate --push`, see
 * test/migrate/push-to-cloud.test.ts); `qfg migrate` skips the rule instead.
 *
 * Anti-vacuity: the planted workspace MUST fail, and the in-subset twin of the
 * same workspace MUST pass, so a check that rejects everything (or nothing)
 * cannot go green.
 */

const errorsOf = (r: ReturnType<typeof validateFileMap>) =>
  r.issues
    .filter((i) => i.severity === 'error')
    .map((i) => ({file: i.file, message: i.message, suggestion: i.suggestion}))

describe('regex v1 at the cli writers (qfg-ktkr.2)', () => {
  describe('validateFileMap (Git hook) and validateWorkspace (qfg verify)', () => {
    it('rejects the planted workspace on both paths, naming each file, reason and hint', () => {
      const fromMap = errorsOf(validateFileMap(plantedFiles(), {validateValues: true}))
      const dir = writeWorkspace(plantedFiles())
      try {
        const fromDisk = errorsOf(validateWorkspace(dir, {validateValues: true}))
        expect(fromDisk).to.deep.equal(fromMap)
      } finally {
        fs.rmSync(dir, {force: true, recursive: true})
      }

      expect(fromMap.map((e) => e.file)).to.deep.equal([
        'feature-flags/planted-redos.json',
        'segments/planted-digit.json',
      ])
      expect(fromMap[0].message).to.include('PROP_MATCHES').and.include('nested-quantifier').and.include('(a+)+$')
      expect(fromMap[1].message).to.include('PROP_DOES_NOT_MATCH').and.include('unicode-shorthand')
      expect(fromMap[1].suggestion).to.include('Use [0-9], [A-Za-z0-9_] or [ \\t\\r\\n\\f\\v].')
      for (const e of fromMap) expect(e.suggestion).to.include(REGEX_V1_DOCS_URL)
    })

    it('accepts the in-subset twin', () => {
      const r = validateFileMap(cleanFiles(), {validateValues: true})
      expect(errorsOf(r)).to.deep.equal([])
    })

    it('rejects a pattern stored with a non-string valueToMatch type', () => {
      for (const [type, value] of [
        ['string_list', ['^a$']],
        ['int', 123],
      ] as const) {
        const files = new Map([
          ['feature-flags/f.json', flag('f', regex('PROP_MATCHES', value, type))],
          ['quonfig.json', JSON.stringify({environments: []})],
        ])
        const errors = errorsOf(validateFileMap(files))
        expect(errors, type).to.have.length(1)
        expect(errors[0].message).to.include('PROP_MATCHES').and.include('needs a string pattern')
      }
    })
  })

  describe('qfg push (commands/push.ts deps.validate)', () => {
    const stubCmd = {log() {}, logToStderr() {}} as unknown as Push

    it('reports the planted patterns as errors and passes the in-subset twin', async () => {
      const {cleanup, deps} = buildRealDeps(stubCmd, 'test-org')
      const bad = writeWorkspace(plantedFiles())
      const good = writeWorkspace(cleanFiles())
      try {
        const badErrors = (await deps.validate(bad)).errors
        expect(badErrors).to.have.length(2)
        expect(badErrors.join('\n')).to.include('nested-quantifier').and.include('unicode-shorthand')
        expect((await deps.validate(good)).errors).to.deep.equal([])
      } finally {
        await cleanup()
        fs.rmSync(bad, {force: true, recursive: true})
        fs.rmSync(good, {force: true, recursive: true})
      }
    })
  })

  describe('qfg migrate (LD importer)', () => {
    const ctx = (): RulesetContext => ({
      report: new ConversionReport(),
      sourceKey: 'ld-flag',
      valueType: 'bool',
      variationValues: [true, false],
    })
    const TRUE = {type: 'bool' as const, value: true}

    it('drops a rule whose pattern is outside v1 and reports it as skipped-rule with the reason', () => {
      const c = ctx()
      const rules = buildRules([{attribute: 'email', op: 'matches', values: ['^\\w+@corp\\.com$']}], TRUE, c)
      expect(rules).to.deep.equal([])
      const skipped = c.report.byCategory('skipped-rule')
      expect(skipped).to.have.length(1)
      expect(skipped[0].detail).to.include('unicode-shorthand').and.include('^\\w+@corp\\.com$')
    })

    it('drops a negated out-of-subset clause too', () => {
      const c = ctx()
      const rules = buildRules([{attribute: 'email', negate: true, op: 'matches', values: ['(a+)+$']}], TRUE, c)
      expect(rules).to.deep.equal([])
      expect(c.report.byCategory('skipped-rule')[0].detail).to.include('nested-quantifier')
    })

    it('keeps an in-subset pattern', () => {
      const c = ctx()
      const rules = buildRules([{attribute: 'email', op: 'matches', values: ['^[0-9]{3}$']}], TRUE, c)
      expect(rules).to.have.length(1)
      expect(c.report.size).to.equal(0)
    })

    it('does not join patterns into an out-of-subset alternation; each is checked on its own', () => {
      const c = ctx()
      const rules = buildRules([{attribute: 'email', op: 'matches', values: ['^[a-z]+$', '\\d']}], TRUE, c)
      // the \d alternative is dropped (reported); the whole rule is dropped
      // rather than kept partial, which would silently narrow targeting
      expect(rules).to.deep.equal([])
      expect(
        c.report
          .byCategory('skipped-rule')
          .map((n) => n.detail)
          .join('\n'),
      ).to.include('unicode-shorthand')
    })
  })

  describe('qfg config-schema', () => {
    it('documents the dialect and links the docs section', () => {
      expect(REFERENCE).to.include('Quonfig regex v1')
      expect(REFERENCE).to.include('\\d \\w \\s \\b (use [0-9], [A-Za-z0-9_], [ \\t\\r\\n\\f\\v])')
      expect(REFERENCE).to.include(REGEX_V1_DOCS_URL)
    })
  })
})
