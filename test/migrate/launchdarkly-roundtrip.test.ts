import {Quonfig} from '@quonfig/node'
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {flagOutputPath, translateFlag} from '../../src/migrate/sources/launchdarkly/translate.js'
import type {LDFlag} from '../../src/migrate/sources/launchdarkly/types.js'

/**
 * The LaunchDarkly converter round-trip tests (plan §6.1 step 4).
 *
 * The golden tests (`launchdarkly-golden.test.ts`) prove the converter emits a
 * specific *structure*. This suite proves that structure is *semantically*
 * correct: convert a raw fixture → write it into a datadir workspace → load it
 * with the in-repo sdk-node SDK → evaluate against known contexts → assert the
 * evaluated value matches what LaunchDarkly itself returns for that same flag,
 * environment, and context.
 *
 * This catches drift a structural diff misses — the converter could emit a
 * perfectly-shaped ruleset that evaluates to the wrong value (the negated-clause
 * / missing-attribute trap from plan §5.3 is exactly this class of bug). Each
 * case below pairs a context with the LaunchDarkly-equivalent expectation,
 * derived directly from the raw fixture's per-environment state.
 */

const RAW_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'launchdarkly', 'raw')

/** Environments present across the round-trip fixture corpus (see _snapshot-meta.json). */
const ENVIRONMENTS = ['production', 'test']

function loadRawFlag(fixture: string): LDFlag {
  return JSON.parse(readFileSync(join(RAW_DIR, `${fixture}.json`), 'utf8')) as LDFlag
}

/**
 * Convert the named raw fixtures and lay them out as a datadir workspace the
 * sdk-node SDK can load: `quonfig.json` + `feature-flags/<key>.json`. Returns
 * the temp directory path; the caller is responsible for nothing — cleanup is
 * registered here.
 */
function buildDatadir(fixtures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ld-roundtrip-'))
  cleanupDirs.push(dir)

  writeFileSync(join(dir, 'quonfig.json'), JSON.stringify({environments: ENVIRONMENTS}, null, 2) + '\n')
  mkdirSync(join(dir, 'feature-flags'), {recursive: true})

  const report = new ConversionReport()
  for (const fixture of fixtures) {
    const flag = loadRawFlag(fixture)
    const quonfig = translateFlag(flag, report)
    writeFileSync(join(dir, flagOutputPath(flag.key)), JSON.stringify(quonfig, null, 2) + '\n')
  }

  return dir
}

const cleanupDirs: string[] = []

async function makeClient(datadir: string, environment: string): Promise<Quonfig> {
  const client = new Quonfig({datadir, enablePolling: false, enableSSE: false, environment})
  await client.init()
  return client
}

describe('migrate/sources/launchdarkly — converter sdk-node round-trip', () => {
  // One datadir holds the whole curated set; each fixture was chosen because its
  // per-environment LaunchDarkly state discriminates on context and/or env, so a
  // converter bug produces a wrong evaluated value rather than a silent pass.
  const FIXTURES = ['fx-rule-multiple-rules', 'fx-rule-single-variation', 'fx-var-number-int', 'fx-var-boolean']
  let datadir: string

  before(() => {
    datadir = buildDatadir(FIXTURES)
  })

  after(() => {
    for (const dir of cleanupDirs) rmSync(dir, {force: true, recursive: true})
  })

  describe('fx-rule-multiple-rules — ordered first-match string rules (test env on, rules US→a / CA→b / GB→c, fallthrough a)', () => {
    it('test env: each country clause resolves to its own variation', async () => {
      const q = await makeClient(datadir, 'test')
      expect(q.getString('fx-rule-multiple-rules', {user: {country: 'US', key: 'u1'}})).to.equal('a')
      expect(q.getString('fx-rule-multiple-rules', {user: {country: 'CA', key: 'u2'}})).to.equal('b')
      expect(q.getString('fx-rule-multiple-rules', {user: {country: 'GB', key: 'u3'}})).to.equal('c')
    })

    it('test env: an unmatched context falls through to variation 0 (a)', async () => {
      const q = await makeClient(datadir, 'test')
      expect(q.getString('fx-rule-multiple-rules', {user: {country: 'FR', key: 'u4'}})).to.equal('a')
    })

    it('production env: flag is off → serves offVariation 1 (b) regardless of context', async () => {
      const q = await makeClient(datadir, 'production')
      expect(q.getString('fx-rule-multiple-rules', {user: {country: 'US', key: 'u1'}})).to.equal('b')
      expect(q.getString('fx-rule-multiple-rules', {user: {country: 'FR', key: 'u4'}})).to.equal('b')
    })
  })

  describe('fx-rule-single-variation — one rule US→c, fallthrough a (test env on, production off→b)', () => {
    it('test env: matching context gets the rule variation, others fall through', async () => {
      const q = await makeClient(datadir, 'test')
      expect(q.getString('fx-rule-single-variation', {user: {country: 'US', key: 'u1'}})).to.equal('c')
      expect(q.getString('fx-rule-single-variation', {user: {country: 'CA', key: 'u2'}})).to.equal('a')
    })

    it('production env: off → offVariation 1 (b)', async () => {
      const q = await makeClient(datadir, 'production')
      expect(q.getString('fx-rule-single-variation', {user: {country: 'US', key: 'u1'}})).to.equal('b')
    })
  })

  describe('fx-var-number-int — int-valued flag, no rules (test env on→fallthrough 0, production off→1)', () => {
    it('test env on: serves fallthrough variation 0 (0)', async () => {
      const q = await makeClient(datadir, 'test')
      expect(q.getNumber('fx-var-number-int', {user: {key: 'u1'}})).to.equal(0)
    })

    it('production env off: serves offVariation 1 (1)', async () => {
      const q = await makeClient(datadir, 'production')
      expect(q.getNumber('fx-var-number-int', {user: {key: 'u1'}})).to.equal(1)
    })
  })

  describe('fx-var-boolean — bool flag, no rules (test env on→fallthrough true, production off→false)', () => {
    it('test env on: serves fallthrough variation 0 (true)', async () => {
      const q = await makeClient(datadir, 'test')
      expect(q.getBool('fx-var-boolean', {user: {key: 'u1'}})).to.equal(true)
    })

    it('production env off: serves offVariation 1 (false)', async () => {
      const q = await makeClient(datadir, 'production')
      expect(q.getBool('fx-var-boolean', {user: {key: 'u1'}})).to.equal(false)
    })
  })
})
