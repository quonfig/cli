import {expect} from 'chai'

import {REFERENCE} from '../../src/commands/config-schema.js'
import {storedConfigJsonSchema} from '../../src/init/schema.js'
import {OPERATORS} from '../../src/verify/validate.js'

function extractReferenceOperators(reference: string): string[] {
  // Pull out the OPERATOR REFERENCE section (between the header and the
  // "valueToMatch format:" line), then take the first all-caps token on
  // each line. This mirrors what a human reader sees in the printed table.
  const start = reference.indexOf('OPERATOR REFERENCE')
  if (start === -1) {
    throw new Error('Could not locate OPERATOR REFERENCE header in config-schema REFERENCE')
  }

  const end = reference.indexOf('valueToMatch format:', start)
  if (end === -1) {
    throw new Error('Could not locate end of OPERATOR REFERENCE table (valueToMatch format:)')
  }

  const section = reference.slice(start, end)
  const found = new Set<string>()
  for (const line of section.split('\n')) {
    const m = line.match(/^ +([A-Z][\dA-Z_]+)\b/)
    if (m) found.add(m[1])
  }

  return [...found]
}

function findOperatorEnumInJsonSchema(node: unknown): string[] | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = findOperatorEnumInJsonSchema(child)
      if (r) return r
    }

    return undefined
  }

  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (
      'enum' in obj &&
      Array.isArray(obj.enum) &&
      (obj.enum as unknown[]).includes('ALWAYS_TRUE')
    ) {
      return obj.enum as string[]
    }

    for (const v of Object.values(obj)) {
      const r = findOperatorEnumInJsonSchema(v)
      if (r) return r
    }
  }

  return undefined
}

describe('operator parity (qfg-teaq)', () => {
  it('every validator operator appears in the human-readable OPERATOR REFERENCE table', () => {
    const referenceOps = new Set(extractReferenceOperators(REFERENCE))
    const validatorOps = new Set<string>(OPERATORS)

    const missingFromReference = [...validatorOps].filter((op) => !referenceOps.has(op))
    const extraInReference = [...referenceOps].filter((op) => !validatorOps.has(op))

    expect(
      missingFromReference,
      `operators accepted by qfg verify but not in qfg config-schema: ${missingFromReference.join(', ')}`,
    ).to.deep.equal([])
    expect(
      extraInReference,
      `operators printed by qfg config-schema but rejected by qfg verify: ${extraInReference.join(', ')}`,
    ).to.deep.equal([])
  })

  it('every validator operator appears in the JSON Schema operator enum', () => {
    const schema = storedConfigJsonSchema()
    const enumOps = findOperatorEnumInJsonSchema(schema)
    expect(enumOps, 'could not find operator enum (one with ALWAYS_TRUE) in JSON schema').to.exist

    const enumSet = new Set(enumOps as string[])
    const validatorOps = new Set<string>(OPERATORS)

    const missingFromEnum = [...validatorOps].filter((op) => !enumSet.has(op))
    const extraInEnum = [...enumSet].filter((op) => !validatorOps.has(op))

    expect(
      missingFromEnum,
      `operators accepted by qfg verify but missing from JSON schema enum: ${missingFromEnum.join(', ')}`,
    ).to.deep.equal([])
    expect(
      extraInEnum,
      `operators in JSON schema enum but not accepted by qfg verify: ${extraInEnum.join(', ')}`,
    ).to.deep.equal([])
  })
})
