import {Quonfig} from '@quonfig/node'
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  buildRules,
  collapseEnvironment,
  joinRegexAlternation,
  type RulesetContext,
} from '../../src/migrate/quonfig-target/ruleset.js'
import {flagOutputPath, translateFlag, translateSegment} from '../../src/migrate/sources/launchdarkly/translate.js'
import type {LDFlag, LDSegment} from '../../src/migrate/sources/launchdarkly/types.js'

/**
 * qfg-ktkr.6: a LaunchDarkly `matches` clause with several values ORs them
 * (the clause matches when ANY pattern matches). The importer used to keep only
 * the first pattern, so the imported rule silently matched fewer contexts.
 *
 * Fix: join the patterns as `(?:a)|(?:b)` while the result stays inside the
 * Quonfig regex v1 safety caps (length <= 256, at most 2 unbounded
 * quantifiers); otherwise emit one rule per pattern (positive) or AND one
 * PROP_DOES_NOT_MATCH per pattern (negated: matches none).
 */

function ctx(over: Partial<RulesetContext> = {}): RulesetContext {
  return {
    report: new ConversionReport(),
    sourceKey: 'fx-flag',
    valueType: 'string',
    variationValues: ['control', 'treatment'],
    ...over,
  }
}

const TREATMENT = {type: 'string' as const, value: 'treatment'}

describe('migrate/quonfig-target — multi-value LD matches (qfg-ktkr.6)', () => {
  it('joins two patterns into one v1 alternation and reports nothing', () => {
    const c = ctx()
    const rules = buildRules([{attribute: 'email', op: 'matches', values: ['^admin@', '\\.edu$']}], TREATMENT, c)
    expect(rules).to.deep.equal([
      {
        criteria: [
          {
            operator: 'PROP_MATCHES',
            propertyName: 'user.email',
            valueToMatch: {type: 'string', value: '(?:^admin@)|(?:\\.edu$)'},
          },
        ],
        value: TREATMENT,
      },
    ])
    expect(c.report.size).to.equal(0)
  })

  it('joins a negated clause under one IS_PRESENT guard (matches none of them)', () => {
    const rules = buildRules(
      [{attribute: 'email', negate: true, op: 'matches', values: ['^admin@', '\\.edu$']}],
      TREATMENT,
      ctx(),
    )
    expect(rules).to.have.length(1)
    expect(rules[0].criteria).to.deep.equal([
      {operator: 'IS_PRESENT', propertyName: 'user.email'},
      {
        operator: 'PROP_DOES_NOT_MATCH',
        propertyName: 'user.email',
        valueToMatch: {type: 'string', value: '(?:^admin@)|(?:\\.edu$)'},
      },
    ])
  })

  it('splits into one rule per pattern when the join exceeds the unbounded-quantifier cap', () => {
    const c = ctx()
    const rules = buildRules(
      [
        {attribute: 'plan', op: 'in', values: ['pro']},
        {attribute: 'email', op: 'matches', values: ['a.*b', 'c.+d', 'e.*f']},
      ],
      TREATMENT,
      c,
    )
    expect(rules).to.have.length(3)
    expect(rules.map((r) => r.criteria[1].valueToMatch)).to.deep.equal([
      {type: 'string', value: 'a.*b'},
      {type: 'string', value: 'c.+d'},
      {type: 'string', value: 'e.*f'},
    ])
    for (const r of rules) {
      expect(r.criteria[0].operator).to.equal('PROP_IS_ONE_OF')
      expect(r.value).to.deep.equal(TREATMENT)
    }

    expect(c.report.byCategory('skipped-rule')).to.have.length(0)
  })

  it('splits when the join exceeds the 256-char length cap', () => {
    const a = 'a'.repeat(200)
    const b = 'b'.repeat(200)
    const rules = buildRules([{attribute: 'email', op: 'matches', values: [a, b]}], TREATMENT, ctx())
    expect(rules.map((r) => r.criteria[0].valueToMatch)).to.deep.equal([
      {type: 'string', value: a},
      {type: 'string', value: b},
    ])
  })

  it('a negated over-cap clause ANDs one PROP_DOES_NOT_MATCH per pattern in one rule, one guard', () => {
    const rules = buildRules(
      [{attribute: 'email', negate: true, op: 'matches', values: ['a.*b', 'c.+d', 'e.*f']}],
      TREATMENT,
      ctx(),
    )
    expect(rules).to.have.length(1)
    expect(rules[0].criteria.map((cr) => [cr.operator, cr.valueToMatch?.value])).to.deep.equal([
      ['IS_PRESENT', undefined],
      ['PROP_DOES_NOT_MATCH', 'a.*b'],
      ['PROP_DOES_NOT_MATCH', 'c.+d'],
      ['PROP_DOES_NOT_MATCH', 'e.*f'],
    ])
  })

  it('counts {n,} as unbounded but not escaped or bracketed * and +', () => {
    expect(joinRegexAlternation(['a{2,}', 'b{3,}', 'c+'])).to.equal(null)
    expect(joinRegexAlternation(['a{2,5}', 'b{3}', 'c+'])).to.equal('(?:a{2,5})|(?:b{3})|(?:c+)')
    expect(joinRegexAlternation(['[*+]x', '\\*y', '\\+z', 'w.*'])).to.equal('(?:[*+]x)|(?:\\*y)|(?:\\+z)|(?:w.*)')
  })

  it('collapseEnvironment keeps every pattern (no more "only the first kept")', () => {
    const c = ctx()
    const rules = collapseEnvironment(
      {
        fallthrough: {variation: 0},
        on: true,
        rules: [{clauses: [{attribute: 'email', op: 'matches', values: ['x', 'y']}], variation: 1}],
      },
      c,
    )
    expect(rules[0].criteria[0].valueToMatch).to.deep.equal({type: 'string', value: '(?:x)|(?:y)'})
    expect(c.report.size).to.equal(0)
  })

  it('segment rules keep every pattern too', () => {
    const report = new ConversionReport()
    const seg = translateSegment(
      {
        key: 'seg-multi',
        rules: [{clauses: [{attribute: 'email', op: 'matches', values: ['a.*b', 'c.+d', 'e.*f']}]}],
      } as unknown as LDSegment,
      report,
    ) as {default: {rules: Array<{criteria: Array<{valueToMatch?: {value: unknown}}>}>}}
    const patterns = seg.default.rules.flatMap((r) => r.criteria.map((cr) => cr.valueToMatch?.value))
    expect(patterns).to.include.members(['a.*b', 'c.+d', 'e.*f'])
  })
})

describe('migrate/sources/launchdarkly — multi-value matches sdk-node round-trip (qfg-ktkr.6)', () => {
  const RAW = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'launchdarkly', 'raw', 'fx-op-matches.json')
  const dirs: string[] = []

  after(() => {
    for (const d of dirs) rmSync(d, {force: true, recursive: true})
  })

  async function evalFlag(patterns: string[], negate: boolean, email?: string): Promise<boolean> {
    // Real LD snapshot (fx-op-matches), retargeted: test env rule serves
    // variation 0 (true) on a multi-value `matches`, fallthrough serves 1 (false).
    const flag = JSON.parse(readFileSync(RAW, 'utf8')) as LDFlag
    const env = (flag.environments as Record<string, any>).test
    env.fallthrough = {variation: 1}
    env.rules[0].clauses[0].values = patterns
    env.rules[0].clauses[0].negate = negate

    const dir = mkdtempSync(join(tmpdir(), 'ld-multi-matches-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'quonfig.json'), JSON.stringify({environments: ['production', 'test']}) + '\n')
    mkdirSync(join(dir, 'feature-flags'), {recursive: true})
    writeFileSync(join(dir, flagOutputPath(flag.key)), JSON.stringify(translateFlag(flag, new ConversionReport())))

    const q = new Quonfig({datadir: dir, enablePolling: false, enableSSE: false, environment: 'test'})
    await q.init()
    return q.getBool('fx-op-matches', {user: email === undefined ? {key: 'u'} : {email, key: 'u'}}) as boolean
  }

  it('joined: a context matching only the SECOND pattern is in the rule (LD ORs values)', async () => {
    expect(await evalFlag(['^admin@', '\\.edu$'], false, 'kid@school.edu')).to.equal(true)
    expect(await evalFlag(['^admin@', '\\.edu$'], false, 'admin@acme.com')).to.equal(true)
    expect(await evalFlag(['^admin@', '\\.edu$'], false, 'bob@acme.com')).to.equal(false)
  })

  it('split: a context matching only the THIRD over-cap pattern is in the rule', async () => {
    const patterns = ['^a.*z$', '^b.+z$', '^c.*z$']
    expect(await evalFlag(patterns, false, 'cxz')).to.equal(true)
    expect(await evalFlag(patterns, false, 'dxz')).to.equal(false)
  })

  it('negated: matches only when NO pattern matches, and never a missing attribute', async () => {
    expect(await evalFlag(['^admin@', '\\.edu$'], true, 'kid@school.edu')).to.equal(false)
    expect(await evalFlag(['^admin@', '\\.edu$'], true, 'bob@acme.com')).to.equal(true)
    expect(await evalFlag(['^a.*z$', '^b.+z$', '^c.*z$'], true, 'cxz')).to.equal(false)
    expect(await evalFlag(['^a.*z$', '^b.+z$', '^c.*z$'], true, 'dxz')).to.equal(true)
    expect(await evalFlag(['^admin@', '\\.edu$'], true)).to.equal(false)
  })
})
