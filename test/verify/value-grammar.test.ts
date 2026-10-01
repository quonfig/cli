import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {validateFileMap, validateWorkspace} from '../../src/verify/validate.js'

// qfg-e87r.30: verify (and so the pre-receive hook) enforces the ONE duration
// grammar shared with qfg create / set-default / override (qfg-2agi.3), and the
// int/double input grammar (qfg-2agi.23), on every value of that type: default
// rules, environment rules, weighted values and variants.

type Value = {type: string; value: unknown}

function configDoc(
  key: string,
  valueType: string,
  values: {default: Value; env?: Value; variant?: Value; weighted?: Value},
) {
  return {
    key,
    type: 'config',
    valueType,
    default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: values.default}]},
    environments: values.env
      ? [{id: 'production', rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: values.env}]}]
      : [],
    variants: [],
  }
}

function flagDoc(key: string, valueType: string, variants: Value[], weighted: Value[]) {
  return {
    key,
    type: 'feature_flag',
    valueType,
    default: {
      rules: [
        {
          criteria: [{operator: 'ALWAYS_TRUE'}],
          value: {
            type: 'weighted_values',
            value: {
              hashByPropertyName: 'user.key',
              weightedValues: weighted.map((value) => ({value, weight: Math.floor(100_000 / weighted.length)})),
            },
          },
        },
      ],
    },
    environments: [],
    variants: variants.map((value) => ({value})),
  }
}

function one(dir: string, doc: {key: string}): Map<string, string> {
  return new Map([[`${dir}/${doc.key}.json`, JSON.stringify(doc)]])
}

function errors(files: Map<string, string>) {
  return validateFileMap(files).issues.filter((i) => i.severity === 'error')
}

const dur = (value: unknown): Value => ({type: 'duration', value})

describe('verify value grammar (qfg-e87r.30)', () => {
  describe('duration', () => {
    for (const bad of ['30s', 'P1DT', 'PT0.5H', 'PT1.5M', 'PT-5S', 'banana', 'pt5s', '', 'PT5S\n', 'P36501D']) {
      it(`rejects ${JSON.stringify(bad)} in a default rule, naming the key and the format`, () => {
        const errs = errors(one('configs', configDoc('my.timeout', 'duration', {default: dur(bad)})))
        expect(errs, JSON.stringify(errs)).to.have.length(1)
        expect(errs[0].message).to.include('default.rules.0.value.value')
        expect(errs[0].message).to.include('"my.timeout"')
        expect(errs[0].message).to.include(JSON.stringify(bad))
        expect(errs[0].message).to.include('ISO 8601')
      })
    }

    it('rejects an invalid duration in an environment rule', () => {
      const errs = errors(one('configs', configDoc('t', 'duration', {default: dur('PT1S'), env: dur('30s')})))
      expect(errs, JSON.stringify(errs)).to.have.length(1)
      expect(errs[0].message).to.include('environments.0.rules.0.value.value')
    })

    it('rejects invalid durations in weighted values and variants', () => {
      const errs = errors(
        one('feature-flags', flagDoc('f', 'duration', [dur('PT1S'), dur('P1DT')], [dur('PT1S'), dur('P1DT')])),
      )
      const paths = errs.map((e) => e.message)
      expect(
        paths.some((m) => m.includes('weightedValues.1.value.value')),
        JSON.stringify(errs),
      ).to.equal(true)
      expect(
        paths.some((m) => m.includes('variants.1.value.value')),
        JSON.stringify(errs),
      ).to.equal(true)
    })

    it('rejects a non-string duration value', () => {
      expect(errors(one('configs', configDoc('t', 'duration', {default: dur(30)})))).to.have.length(1)
    })

    for (const good of ['PT30S', 'PT1H30M', 'P1DT6H2M1.5S', 'PT0.2S', 'P36500D', 'PT0S', 'PT876000H']) {
      it(`accepts ${JSON.stringify(good)}`, () => {
        const result = validateFileMap(one('configs', configDoc('t', 'duration', {default: dur(good), env: dur(good)})))
        expect(result.valid, JSON.stringify(result.issues)).to.equal(true)
      })
    }

    it('accepts valid durations in weighted values and variants', () => {
      const result = validateFileMap(
        one('feature-flags', flagDoc('f', 'duration', [dur('PT1S'), dur('PT5M')], [dur('PT1S'), dur('PT5M')])),
      )
      expect(result.valid, JSON.stringify(result.issues)).to.equal(true)
    })

    it('rejects a fixture tree on disk with 30s, P1DT and PT0.5H (validateWorkspace)', () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-duration-'))
      try {
        fs.mkdirSync(path.join(ws, 'configs'))
        fs.mkdirSync(path.join(ws, 'feature-flags'))
        fs.writeFileSync(path.join(ws, 'quonfig.json'), JSON.stringify({environments: []}))
        const write = (dir: string, doc: {key: string}) =>
          fs.writeFileSync(path.join(ws, dir, `${doc.key}.json`), JSON.stringify(doc, null, 2))
        write('configs', configDoc('a.timeout', 'duration', {default: dur('30s')}))
        write('configs', configDoc('b.timeout', 'duration', {default: dur('PT1S'), env: dur('P1DT')}))
        write('feature-flags', flagDoc('c.flag', 'duration', [dur('PT1S'), dur('PT0.5H')], [dur('PT1S')]))
        write('configs', configDoc('ok.timeout', 'duration', {default: dur('PT30S')}))

        const result = validateWorkspace(ws)
        expect(result.valid).to.equal(false)
        const errs = result.issues.filter((i) => i.severity === 'error')
        expect(errs.map((e) => e.file).sort(), JSON.stringify(errs)).to.deep.equal([
          'configs/a.timeout.json',
          'configs/b.timeout.json',
          'feature-flags/c.flag.json',
        ])
      } finally {
        fs.rmSync(ws, {force: true, recursive: true})
      }
    })
  })

  describe('int and double (qfg-2agi.23 grammar)', () => {
    for (const bad of ['abc', 1.5, '12abc', 1e300, '1.5', ' ', '0x10', 2 ** 53, '99999999999999999999']) {
      it(`rejects int ${JSON.stringify(bad)}`, () => {
        const errs = errors(one('configs', configDoc('n', 'int', {default: {type: 'int', value: bad}})))
        expect(errs, JSON.stringify(errs)).to.have.length(1)
        expect(errs[0].message).to.include('"n"')
      })
    }

    for (const good of [0, -5, 42, '42', '-7', 2 ** 53 - 1]) {
      it(`accepts int ${JSON.stringify(good)}`, () => {
        const result = validateFileMap(one('configs', configDoc('n', 'int', {default: {type: 'int', value: good}})))
        expect(result.valid, JSON.stringify(result.issues)).to.equal(true)
      })
    }

    for (const bad of ['abc', 'NaN', 'Infinity', '1.5abc', '1e400', ' ']) {
      it(`rejects double ${JSON.stringify(bad)}`, () => {
        const errs = errors(one('configs', configDoc('d', 'double', {default: {type: 'double', value: bad}})))
        expect(errs, JSON.stringify(errs)).to.have.length(1)
        expect(errs[0].message).to.include('"d"')
      })
    }

    for (const good of [1.5, -2, 0, '2.5', '.5', '-1.5e3', 1e300]) {
      it(`accepts double ${JSON.stringify(good)}`, () => {
        const result = validateFileMap(
          one('configs', configDoc('d', 'double', {default: {type: 'double', value: good}})),
        )
        expect(result.valid, JSON.stringify(result.issues)).to.equal(true)
      })
    }
  })
})
