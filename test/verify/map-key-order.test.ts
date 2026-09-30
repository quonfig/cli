import {expect} from 'chai'

import {findMapKeyOrderWarnings, isIntegerKey, scanOrderedJson} from '../../src/verify/map-key-order.js'

describe('map-key-order (qfg-e87r.21)', () => {
  const schema = {type: 'object', additionalProperties: {type: 'integer'}}

  it('does not scan the file when no map has an integer key', () => {
    const readOrdered = () => {
      throw new Error('scanner must not run')
    }

    expect(findMapKeyOrderWarnings(schema, {a: 1, b: 2}, readOrdered, 'value')).to.deep.equal([])
  })

  it('follows local $ref and oneOf into a map', () => {
    const refSchema = {
      $defs: {byTenant: {type: 'object', additionalProperties: {type: 'integer'}}},
      oneOf: [{type: 'object', properties: {m: {$ref: '#/$defs/byTenant'}}}],
    }
    const text = '{"m": {"x": 1, "2": 2}}'
    const warnings = findMapKeyOrderWarnings(refSchema, JSON.parse(text), () => scanOrderedJson(text), 'value')
    expect(warnings).to.deep.equal([{integerKeys: ['2'], path: 'value.m'}])
  })

  it('classifies integer keys like JavaScript does', () => {
    for (const key of ['0', '5', '1001', '4294967294']) expect(isIntegerKey(key), key).to.be.true
    for (const key of ['007', '-1', '1.5', '5a', 'tenant-1001', '4294967295', '', ' 1']) {
      expect(isIntegerKey(key), key).to.be.false
    }
  })

  it('scanner keeps file order, decodes escaped keys, and keeps the first position of a duplicate', () => {
    const node = scanOrderedJson('{ "b\\u0061" : [1, {"z": null}], "5": "x\\"y", "a": true, "b\\u0061": 2 }')
    expect(node?.kind).to.equal('object')
    expect(node?.kind === 'object' && node.keys).to.deep.equal(['ba', '5', 'a'])
  })

  it('scanner returns undefined on text that is not JSON', () => {
    expect(scanOrderedJson('{"a": ')).to.equal(undefined)
    expect(scanOrderedJson('{"a": 1} x')).to.equal(undefined)
  })
})
