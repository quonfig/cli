import {expect} from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {isValidIsoDuration} from '../../src/util/coerce.js'

// The ONE duration grammar (qfg-2agi.29) lives in integration-test-data as
// tests/duration/grammar.yaml. qfg create / set-default / override / verify
// all share isValidIsoDuration, so this test holds that function to the
// fixture. Locally the fixture is the sibling checkout in the monorepo;
// QUONFIG_ITD_DIR points somewhere else (e.g. a CI checkout).
const here = path.dirname(fileURLToPath(import.meta.url))
const itdDir = process.env.QUONFIG_ITD_DIR ?? path.resolve(here, '../../../integration-test-data')
const fixturePath = path.join(itdDir, 'tests', 'duration', 'grammar.yaml')

type Fixture = {invalid: string[]; valid: {millis: number; value: string}[]}

// The fixture's shape is fixed and tiny (see its header), so a line parser is
// enough and avoids a YAML dependency. Every scalar is a double-quoted string
// whose escapes (\n, \uXXXX) are JSON-compatible. Any "- " line in a section
// that does not parse is a hard failure, so an entry can never be dropped
// silently.
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`
const VALID_LINE = new RegExp(String.raw`^\s*-\s*\{\s*value:\s*(${QUOTED})\s*,\s*millis:\s*(\d+)\s*\}\s*$`)
const INVALID_LINE = new RegExp(String.raw`^\s*-\s*(${QUOTED})\s*$`)

function loadFixture(file: string): Fixture {
  const fixture: Fixture = {invalid: [], valid: []}
  let section: 'invalid' | 'valid' | undefined
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    if (/^valid:\s*$/.test(line)) {
      section = 'valid'
      continue
    }

    if (/^invalid:\s*$/.test(line)) {
      section = 'invalid'
      continue
    }

    if (!/^\s*-/.test(line)) continue
    if (section === 'valid') {
      const m = VALID_LINE.exec(line)
      if (!m) throw new Error(`unparsed valid entry in ${file}: ${line}`)
      fixture.valid.push({millis: Number(m[2]), value: JSON.parse(m[1]) as string})
    } else if (section === 'invalid') {
      const m = INVALID_LINE.exec(line)
      if (!m) throw new Error(`unparsed invalid entry in ${file}: ${line}`)
      fixture.invalid.push(JSON.parse(m[1]) as string)
    } else {
      throw new Error(`list entry outside valid/invalid in ${file}: ${line}`)
    }
  }

  return fixture
}

describe('duration grammar (isValidIsoDuration)', () => {
  // Always-on cases so a run without the fixture is not vacuous.
  describe('core cases', () => {
    for (const value of ['PT30S', 'PT1H30M', 'P1DT6H2M1.5S', 'PT0.2S', 'P36500D']) {
      it(`accepts ${JSON.stringify(value)}`, () => expect(isValidIsoDuration(value)).to.equal(true))
    }

    for (const value of ['P1DT', 'PT', 'PT0.5H', 'PT1.5M', '30s', 'P36501D', 'PT5S\n']) {
      it(`rejects ${JSON.stringify(value)}`, () => expect(isValidIsoDuration(value)).to.equal(false))
    }
  })

  describe(`ITD fixture ${fixturePath}`, () => {
    if (!fs.existsSync(fixturePath)) {
      it('fixture is present (set QUONFIG_ITD_DIR or check out integration-test-data beside cli)', function () {
        this.skip()
      })
      return
    }

    const fixture = loadFixture(fixturePath)

    it('has entries in both lists', () => {
      expect(fixture.valid.length).to.be.greaterThan(0)
      expect(fixture.invalid.length).to.be.greaterThan(0)
    })

    for (const {value} of fixture.valid) {
      it(`accepts ${JSON.stringify(value)}`, () => expect(isValidIsoDuration(value)).to.equal(true))
    }

    for (const value of fixture.invalid) {
      it(`rejects ${JSON.stringify(value)}`, () => expect(isValidIsoDuration(value)).to.equal(false))
    }
  })
})
