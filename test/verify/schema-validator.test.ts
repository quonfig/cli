import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {duplicateItemIndexes, schemaErrorsToViolations} from '../../src/verify/schema-error-reshape.js'
import {validateAgainstSchema} from '../../src/verify/schema-validator.js'

/**
 * qfg-phcv: the CLI copy of the app's validator must give the app's verdict.
 * Both fixture files are shared with app-quonfig (synthetic only, the cli
 * repo is public):
 * - schema-error-reshape.cases.json is a verbatim copy of
 *   app-quonfig src/lib/domain/__fixtures__/schema-error-reshape.cases.json.
 * - schema-validation.cases.json is mirrored at the same path in app-quonfig
 *   and run there against its validateAgainstSchema.
 * Change them in both repos together.
 */
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readFixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')) as T

type Violation = {message: string; path: string}

const reshape = readFixture<{
  cases: Array<{name: string; schema: string; value: unknown; violations: Violation[]}>
  schemas: Record<string, Record<string, unknown>>
}>('schema-error-reshape.cases.json')

const validation = readFixture<{
  cases: Array<{name: string; result: unknown; schema: string; value: unknown}>
  schemas: Record<string, Record<string, unknown>>
}>('schema-validation.cases.json')

describe('verify schema validator (qfg-phcv)', () => {
  describe('shared reshape cases (copied from app-quonfig)', () => {
    for (const c of reshape.cases) {
      it(c.name, () => {
        const result = validateAgainstSchema(reshape.schemas[c.schema], c.value)
        if (c.violations.length === 0) {
          expect(result).to.deep.equal({ok: true})
        } else {
          expect(result).to.deep.equal({kind: 'violations', ok: false, violations: c.violations})
        }
      })
    }
  })

  describe('shared validation cases (Jev, compile errors, draft-07, keywords)', () => {
    for (const c of validation.cases) {
      it(c.name, () => {
        expect(validateAgainstSchema(validation.schemas[c.schema], c.value)).to.deep.equal(c.result)
      })
    }
  })

  it('two schemas with the same $id compile independently (addUsedSchema: false)', () => {
    const a = {$id: 'https://quonfig.test/same', type: 'string'}
    const b = {$id: 'https://quonfig.test/same', type: 'integer'}
    expect(validateAgainstSchema(a, 'x')).to.deep.equal({ok: true})
    expect(validateAgainstSchema(b, 3)).to.deep.equal({ok: true})
    expect(validateAgainstSchema(b, 'x')).to.deep.equal({
      kind: 'violations',
      ok: false,
      violations: [{message: 'must be integer', path: ''}],
    })
  })

  it('schemaErrorsToViolations never returns an empty list', () => {
    expect(schemaErrorsToViolations([], {}, {})).to.deep.equal([{message: 'does not match the schema', path: ''}])
  })

  it('duplicateItemIndexes reads the 0-based pair back from the duplicate-items message (qfg-e87r.14)', () => {
    expect(duplicateItemIndexes('must NOT have duplicate items (items 2 and 4 are identical)')).to.deep.equal([1, 3])
    expect(duplicateItemIndexes('must NOT have duplicate items (items ## 3 and 1 are identical)')).to.equal(undefined)
    expect(duplicateItemIndexes('must be string')).to.equal(undefined)
  })
})
