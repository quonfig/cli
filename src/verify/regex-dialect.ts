/**
 * "Quonfig regex v1": the regex dialect of PROP_MATCHES and PROP_DOES_NOT_MATCH
 * (qfg-ktkr.2). Spec: project/plans/2026-10-12-regex-write-time-check.md
 * section 2, approved 2026-10-16 (qfg-goi1.10.10). Fixture of record:
 * integration-test-data tests/regex/dialect.yaml (tag v2026.10.22), which
 * test/verify/regex-dialect.test.ts holds this file to, row by row.
 *
 * The dialect is the intersection of what every SDK's engine (go RE2, node
 * RegExp, python re, ruby Onigmo, java.util.regex, .NET Regex) accepts and
 * reads the same way, plus a ReDoS safety rule. SDKs do not validate; the
 * writers (this check, app-quonfig's copy, and the Git hook built from this
 * repo) are the only gate.
 *
 * No imports: src/verify/ is bundled into the standalone qfg-verify hook.
 */

export const REGEX_V1_LIMITS = {maxLength: 256, maxRepeat: 1000, maxUnboundedQuantifiers: 2} as const

/** The canonical docs section the error links to (qfg-ktkr.5 owns the page). */
export const REGEX_V1_DOCS_URL =
  'https://docs.quonfig.com/docs/explanations/features/rules-and-segmentation#quonfig-regex-v1'

export type RegexV1Reason =
  | 'backref'
  | 'bad-repeat'
  | 'class-syntax'
  | 'group-extension'
  | 'inline-flag'
  | 'lookaround'
  | 'named-group'
  | 'nested-quantifier'
  | 'octal'
  | 'possessive'
  | 'syntax'
  | 'too-long'
  | 'too-many-unbounded'
  | 'unicode-shorthand'
  | 'unsupported-escape'

/** Fix-it hints, verbatim from the fixture's `hints` map. */
export const REGEX_V1_HINTS: Record<RegexV1Reason, string> = {
  'too-long': 'Regex patterns are limited to 256 characters.',
  syntax:
    'This is not a valid regular expression. Check for an unbalanced ( ) or [ ], a trailing \\, a reversed range such as [z-a], or a quantifier with nothing before it (a quantifier cannot follow ^, $, |, ( or another quantifier).',
  lookaround:
    'Lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not supported. Rewrite the pattern without them, or split the rule into two criteria.',
  'named-group':
    "Named groups ((?<name>...), (?P<name>...), (?'name'...)) are not supported. Use a plain group ( ) or (?: ).",
  'inline-flag':
    'Inline flags such as (?i) are not supported. Spell out both cases with a class, for example [Hh]ello.',
  'group-extension':
    'Only ( ) and (?: ) groups are supported. Atomic groups (?>...), comments (?#...), conditionals and other (? forms are not.',
  backref: 'Backreferences (\\1 to \\9, \\k<name>) are not supported. Repeat the text explicitly instead.',
  octal: 'Octal escapes and \\0 are not supported. Write the character as \\xHH, for example \\x00.',
  possessive:
    'Possessive quantifiers (*+, ++, ?+, {n}+) are not supported. Use the plain form (a+) or the lazy form (a+?).',
  'bad-repeat':
    'Write repeat counts as {n}, {n,} or {n,m} with n <= m <= 1000. {,m} is not portable: write {0,m}. Escape a literal brace as \\{.',
  'class-syntax':
    'Inside [...] use only literals, ranges and escapes. POSIX classes such as [:digit:], a nested [, &&, --, ~~ and || are not supported. Escape a literal [ or ] as \\[ or \\], and do not start a class with ].',
  'unicode-shorthand':
    '\\d, \\w, \\s, \\b and their negations match different characters in different SDKs. Use [0-9], [A-Za-z0-9_] or [ \\t\\r\\n\\f\\v].',
  'unsupported-escape':
    'This escape is not supported. The supported escapes are \\ followed by ASCII punctuation, \\t \\n \\r \\f \\v, and \\xHH with exactly two hex digits.',
  'nested-quantifier':
    'A quantifier cannot apply to a group that contains a quantifier or a |, as in (a+)+ or (a|b)*. Such patterns can take exponential time. Quantify the inner part only, or use a class: [ab]* instead of (a|b)*.',
  'too-many-unbounded':
    'A pattern can have at most 2 unbounded quantifiers (*, +, {n,}). Bound the extra ones with {n,m}, or split the rule into two criteria.',
}

export interface RegexV1Violation {
  hint: string
  reason: RegexV1Reason
}

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
const SIMPLE_ESCAPES: Record<string, number> = {f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b}
const SHORTHANDS = 'dDwWsSbB'
const HEX = /^[\dA-Fa-f]{2}$/

class Violation {
  constructor(readonly reason: RegexV1Reason) {}
}

const fail = (reason: RegexV1Reason): never => {
  throw new Violation(reason)
}

/**
 * Check one pattern against Quonfig regex v1. Returns null when the pattern is
 * in the dialect, or the reason and fix-it hint for the first violation.
 *
 * Precedence (fixture header): too-long first; then one left-to-right scan
 * reports the first offending construct (an unclosed ( or [ is found at the
 * end); then too-many-unbounded, which needs the whole pattern.
 */
export function checkRegexV1(pattern: string): null | RegexV1Violation {
  const cps = [...pattern]
  try {
    if (cps.length > REGEX_V1_LIMITS.maxLength) fail('too-long')
    const unbounded = scan(cps)
    if (unbounded > REGEX_V1_LIMITS.maxUnboundedQuantifiers) fail('too-many-unbounded')
    return null
  } catch (error) {
    if (error instanceof Violation) return {hint: REGEX_V1_HINTS[error.reason], reason: error.reason}
    throw error
  }
}

type Last = 'atom' | 'group' | 'none' | 'quantifier'

/** Scan the pattern; returns the unbounded-quantifier count or throws a Violation. */
function scan(p: string[]): number {
  // One frame per open group: does it (transitively) contain a quantifier or |?
  const groups: boolean[] = []
  let last: Last = 'none'
  let lastGroupRisky = false
  let unbounded = 0
  let i = 0

  const markRisky = () => {
    if (groups.length > 0) groups[groups.length - 1] = true
  }

  /** At p[i] === '{': parse a repeat. Returns [end index, unbounded] or throws. */
  const parseRepeat = (): [number, boolean] => {
    let j = i + 1
    let n = ''
    while (j < p.length && p[j] >= '0' && p[j] <= '9') n += p[j++]
    let m: string | undefined
    let comma = false
    if (p[j] === ',') {
      comma = true
      j++
      m = ''
      while (j < p.length && p[j] >= '0' && p[j] <= '9') m += p[j++]
    }

    if (p[j] !== '}' || n === '') fail('bad-repeat') // {,m}, a bare {, x{foo}
    const lo = Number(n)
    const hi = comma && m !== '' ? Number(m) : undefined
    if (lo > REGEX_V1_LIMITS.maxRepeat || (hi !== undefined && (hi > REGEX_V1_LIMITS.maxRepeat || hi < lo)))
      fail('bad-repeat')
    return [j, comma && m === '']
  }

  /** At p[i] === '\\': validate one escape, return its code point (or -1 for a non-literal). */
  const parseEscape = (): number => {
    const c = p[i + 1]
    if (c === undefined) fail('syntax')
    if (c >= '1' && c <= '9') fail('backref')
    if (c === 'k') fail('backref')
    if (c === '0') fail('octal')
    if (SHORTHANDS.includes(c)) fail('unicode-shorthand')
    if (c in SIMPLE_ESCAPES) {
      i += 2
      return SIMPLE_ESCAPES[c]
    }

    if (c === 'x') {
      const hex = (p[i + 2] ?? '') + (p[i + 3] ?? '')
      if (!HEX.test(hex)) fail('unsupported-escape')
      i += 4
      return Number.parseInt(hex, 16)
    }

    if (c.length === 1 && ASCII_PUNCT.includes(c)) {
      i += 2
      return c.codePointAt(0)!
    }

    return fail('unsupported-escape')
  }

  const parseClass = () => {
    // p[i] === '['
    i++
    if (p[i] === '^') i++
    if (p[i] === ']') fail('class-syntax') // []a] / [^]a] read differently in node
    const start = i
    let prev: number | undefined // code point of the previous single literal, for ranges
    for (;;) {
      const c = p[i]
      if (c === undefined) fail('syntax') // unclosed [
      if (c === ']') {
        const body = p.slice(start, i)
        if (body.length >= 2 && body[0] === ':' && body.at(-1) === ':') fail('class-syntax') // [:alpha:]
        i++
        return
      }

      if (c === '[') fail('class-syntax') // nested [ and [[:x:]]
      if ('&-~|'.includes(c) && p[i + 1] === c) fail('class-syntax') // && -- ~~ ||
      if (c === '-' && prev !== undefined && p[i + 1] !== ']' && p[i + 1] !== undefined) {
        i++
        if (p[i] === '[') fail('class-syntax')
        const hi = p[i] === '\\' ? parseEscape() : p[i++].codePointAt(0)!
        if (hi < prev) fail('syntax') // [z-a]
        prev = undefined
        continue
      }

      prev = c === '\\' ? parseEscape() : p[i++].codePointAt(0)!
    }
  }

  while (i < p.length) {
    const c = p[i]
    switch (c) {
      case '\\': {
        parseEscape()
        last = 'atom'
        continue
      }

      case '[': {
        parseClass()
        last = 'atom'
        continue
      }

      case '(': {
        if (p[i + 1] === '?') {
          const a = p[i + 2]
          const b = p[i + 3]
          if (a === ':') {
            i += 3
          } else if (a === '=' || a === '!' || (a === '<' && (b === '=' || b === '!'))) {
            fail('lookaround')
          } else if (a === '<' || a === 'P' || a === "'") {
            fail('named-group')
          } else if (a !== undefined && /[A-Za-z-]/.test(a)) {
            fail('inline-flag')
          } else if (a === undefined) {
            fail('syntax')
          } else {
            fail('group-extension')
          }
        } else {
          i++
        }

        groups.push(false)
        last = 'none'
        continue
      }

      case ')': {
        if (groups.length === 0) fail('syntax')
        lastGroupRisky = groups.pop()!
        if (lastGroupRisky) markRisky() // "contains" is transitive
        last = 'group'
        i++
        continue
      }

      case '|': {
        markRisky()
        last = 'none'
        break
      }

      case '^':
      case '$': {
        last = 'none'
        break
      }

      case '*':
      case '+':
      case '?':
      case '{': {
        let end = i
        let isUnbounded = c === '*' || c === '+'
        if (c === '{') [end, isUnbounded] = parseRepeat()
        if (last === 'none' || last === 'quantifier') fail('syntax')
        if (last === 'group' && lastGroupRisky) fail('nested-quantifier')
        markRisky()
        if (isUnbounded) unbounded++
        i = end + 1
        if (p[i] === '?')
          i++ // lazy
        else if (p[i] === '+') fail('possessive')
        last = 'quantifier'
        continue
      }

      default: {
        last = 'atom'
      }
    }

    i++
  }

  if (groups.length > 0) fail('syntax') // unclosed (
  return unbounded
}
