import {expect} from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  REGEX_V1_DOCS_URL,
  REGEX_V1_HINTS,
  REGEX_V1_LIMITS,
  type RegexV1Reason,
  checkRegexV1,
} from '../../src/verify/regex-dialect.js'

// "Quonfig regex v1" (qfg-ktkr.2) is pinned in integration-test-data as
// tests/regex/dialect.yaml (tag v2026.10.22.1: qfg-ktkr.1, narrowed by
// qfg-ktkr.7). This test holds
// src/verify/regex-dialect.ts to every accept/reject row, reason code and
// hint in that fixture. Locally the fixture is the sibling checkout in the
// monorepo; QUONFIG_ITD_DIR points somewhere else (e.g. a CI checkout).
const here = path.dirname(fileURLToPath(import.meta.url))
const itdDir = process.env.QUONFIG_ITD_DIR ?? path.resolve(here, '../../../integration-test-data')
const fixturePath = path.join(itdDir, 'tests', 'regex', 'dialect.yaml')

type Fixture = {
  accept: string[]
  hints: Record<string, string>
  limits: Record<string, number>
  reject: {pattern: string; reason: string}[]
}

// The fixture's shape is fixed (see its header), so a line parser is enough
// and avoids a YAML dependency. Patterns are single-quoted YAML scalars, where
// '' is one quote and a backslash is literal. Any list entry that does not
// parse is a hard failure, so a row can never be dropped silently.
const SQ = String.raw`'((?:[^']|'')*)'`
const ROW = new RegExp(
  String.raw`^\s*-\s*\{\s*pattern:\s*${SQ}\s*(?:,\s*reason:\s*([a-z-]+)\s*)?(?:,\s*note:\s*'(?:[^']|'')*'\s*)?\}\s*$`,
)
const HINT = new RegExp(String.raw`^\s+([a-z-]+):\s*${SQ}\s*$`)
const LIMIT = /^\s+([_a-z]+):\s*(\d+)\s*$/
const unquote = (s: string) => s.replaceAll("''", "'")

function loadFixture(file: string): Fixture {
  const fx: Fixture = {accept: [], hints: {}, limits: {}, reject: []}
  let section = ''
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    const top = /^([_a-z]+):/.exec(line)
    if (top) {
      section = top[1]
      continue
    }

    switch (section) {
      case 'limits': {
        const m = LIMIT.exec(line)
        if (!m) throw new Error(`unparsed limit in ${file}: ${line}`)
        fx.limits[m[1]] = Number(m[2])

        break
      }
      case 'hints': {
        const m = HINT.exec(line)
        if (!m) throw new Error(`unparsed hint in ${file}: ${line}`)
        fx.hints[m[1]] = unquote(m[2])

        break
      }
      case 'accept':
      case 'reject': {
        const m = ROW.exec(line)
        if (!m) throw new Error(`unparsed ${section} row in ${file}: ${line}`)
        if (section === 'accept') {
          if (m[2]) throw new Error(`accept row with a reason in ${file}: ${line}`)
          fx.accept.push(unquote(m[1]))
        } else {
          if (!m[2]) throw new Error(`reject row without a reason in ${file}: ${line}`)
          fx.reject.push({pattern: unquote(m[1]), reason: m[2]})
        }

        break
      }
      case 'open_questions': {
        throw new Error(`open_questions is gone since qfg-ktkr.7; found it in ${file}`)
      }
      // No default
    }
  }

  return fx
}

const accepts = (pattern: string) => {
  const r = checkRegexV1(pattern)
  expect(r, `${JSON.stringify(pattern)} should be accepted, got ${JSON.stringify(r)}`).to.equal(null)
}

const rejects = (pattern: string, reason: RegexV1Reason | string) => {
  const r = checkRegexV1(pattern)
  expect(r, `${JSON.stringify(pattern)} should be rejected`).to.not.equal(null)
  expect(r!.reason, JSON.stringify(pattern)).to.equal(reason)
  expect(r!.hint).to.equal(REGEX_V1_HINTS[r!.reason])
}

describe('Quonfig regex v1 (checkRegexV1)', () => {
  // Always-on cases, so a run without the ITD checkout (CI) is not vacuous.
  describe('core cases', () => {
    for (const p of [
      'a+b+',
      '^[0-9]{3}$',
      '^(foo|bar)$',
      '.*foo.*',
      '[\\x00-\\x1f]',
      '@example\\.com$',
      'a_b\\x0B\\x7F',
    ]) {
      it(`accepts ${JSON.stringify(p)}`, () => accepts(p))
    }

    const core: [string, RegexV1Reason][] = [
      ['(a+)+$', 'nested-quantifier'],
      ['\\d', 'unicode-shorthand'],
      ['^\\w+$', 'unicode-shorthand'],
      ['foo(?=bar)', 'lookaround'],
      ['(?i)abc', 'inline-flag'],
      ['a{1001}', 'bad-repeat'],
      ['.*.*.*', 'too-many-unbounded'],
      ['(abc', 'syntax'],
      ['a'.repeat(257), 'too-long'],
      // qfg-ktkr.7: not portable, so rejected.
      ['\\_', 'unsupported-escape'],
      ['^\\v$', 'unsupported-escape'],
      ['\\xe9', 'unsupported-escape'],
      ['[\\x80-\\xff]', 'unsupported-escape'],
    ]
    for (const [p, reason] of core) {
      it(`rejects ${JSON.stringify(p.length > 40 ? p.slice(0, 20) + '...' : p)} as ${reason}`, () => rejects(p, reason))
    }

    it('the \\d hint carries the Q2 replacement classes', () => {
      expect(checkRegexV1('\\d')!.hint).to.include('[0-9], [A-Za-z0-9_] or [ \\t\\r\\n\\f\\x0B]')
    })

    it('the unsupported-escape hint names the qfg-ktkr.7 replacements', () => {
      const {hint} = checkRegexV1('\\v')!
      expect(hint).to.include('Write _ unescaped instead of \\_, \\x0B instead of \\v')
    })

    it('links a stable docs anchor', () => {
      expect(REGEX_V1_DOCS_URL).to.match(/^https:\/\/docs\.quonfig\.com\/docs\/.+#quonfig-regex-v1$/)
    })
  })

  describe(`ITD fixture ${fixturePath}`, () => {
    if (!fs.existsSync(fixturePath)) {
      it('fixture is present (set QUONFIG_ITD_DIR or check out integration-test-data beside cli)', function () {
        this.skip()
      })
      return
    }

    const fx = loadFixture(fixturePath)

    it('has rows in both lists and a hint for every reason', () => {
      expect(fx.accept.length).to.be.greaterThan(20)
      expect(fx.reject.length).to.be.greaterThan(50)
      for (const {reason} of fx.reject) expect(fx.hints, reason).to.have.property(reason)
    })

    it('limits match', () => {
      expect(fx.limits).to.deep.equal({
        max_length: REGEX_V1_LIMITS.maxLength,
        max_repeat: REGEX_V1_LIMITS.maxRepeat,
        max_unbounded_quantifiers: REGEX_V1_LIMITS.maxUnboundedQuantifiers,
      })
    })

    it('hints match the fixture text exactly', () => {
      expect(REGEX_V1_HINTS).to.deep.equal(fx.hints)
    })

    for (const p of fx.accept) {
      it(`accepts ${JSON.stringify(p.length > 40 ? p.slice(0, 20) + '...' : p)}`, () => accepts(p))
    }

    for (const {pattern, reason} of fx.reject) {
      it(`rejects ${JSON.stringify(pattern.length > 40 ? pattern.slice(0, 20) + '...' : pattern)} as ${reason}`, () =>
        rejects(pattern, reason))
    }
  })
})
