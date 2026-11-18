/**
 * qfg-5bjew.48: `qfg cr show` (and every CR diff the CLI prints) masks secrets
 * the way the web review page does (app-quonfig
 * src/lib/domain/change-request-diff/mask.ts): ciphertext shows as
 * [encrypted] / [encrypted, changed], confidential plaintext as
 * [confidential *****<md5[0:5]>, N chars].
 */

import {expect} from 'chai'
import {createHash} from 'node:crypto'

import type {ChangeRequestDetail, ChangeRequestFile} from '../../src/change-requests/types.js'

import {maskFile} from '../../src/change-requests/mask.js'
import {renderMergeSummary, renderShow} from '../../src/change-requests/render.js'

const CIPHER_OLD = 'aaaa1111bbbb2222cccc3333--dddd4444eeee5555--ffff6666aaaa7777'
const CIPHER_NEW = '9999888877776666--5555444433332222--1111000099998888'
const PLAIN = 'hunter2-confidential-plaintext'
const fp = (s: string) => `*****${createHash('md5').update(s).digest('hex').slice(0, 5)}`

const configText = (cipher: string, confidential: string, extra = '') =>
  JSON.stringify(
    {
      key: 'cr41.secret',
      type: 'config',
      valueType: 'string',
      default: {
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'string', value: cipher, confidential: true, decryptWith: 'cr41.key'},
          },
        ],
      },
      environments: [
        {
          id: 'production',
          rules: [
            {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: confidential, confidential: true}},
          ],
        },
      ],
      description: `plain${extra}`,
    },
    null,
    2,
  ) + '\n'

const file = (before: null | string, after: null | string): ChangeRequestFile => ({
  after,
  afterOid: after === null ? null : '2'.repeat(40),
  before,
  beforeOid: before === null ? null : '1'.repeat(40),
  kind: before === null ? 'add' : after === null ? 'delete' : 'modify',
  path: 'configs/cr41.secret.json',
})

const detail = (files: ChangeRequestFile[]): ChangeRequestDetail => ({
  baseSha: 'd'.repeat(40),
  blockedBy: null,
  branch: 'cr/14',
  callerCanClose: true,
  callerCanMerge: true,
  callerDenials: [],
  closed: null,
  conflicts: [],
  createdAt: '2026-11-18T10:00:00.000Z',
  description: null,
  files,
  filesSource: 'main',
  headSha: 'c'.repeat(40),
  mainSha: 'e'.repeat(40),
  merged: null,
  mergeable: true,
  mergeBase: 'd'.repeat(40),
  number: 14,
  proposedByCaller: false,
  proposer: {channel: 'mcp', email: null, label: 'Riley'},
  status: 'open',
  title: 't',
  updatedAt: '2026-11-18T10:00:00.000Z',
  url: '/workspaces/w/change-requests/14',
})

describe('change-request secret masking (qfg-5bjew.48)', () => {
  it('cr show never prints ciphertext or confidential plaintext; a changed secret shows as changed', () => {
    const text = renderShow(detail([file(configText(CIPHER_OLD, PLAIN), configText(CIPHER_NEW, PLAIN))])).join('\n')
    expect(text).to.not.include(CIPHER_OLD)
    expect(text).to.not.include(CIPHER_NEW)
    expect(text).to.not.include(PLAIN)
    expect(text).to.match(/^\s+- \s+"value": "\[encrypted]",$/m)
    expect(text).to.match(/^\s+\+ \s+"value": "\[encrypted, changed]",$/m)
  })

  it('an untouched secret produces no diff line; only the real change shows', () => {
    const text = renderShow(
      detail([file(configText(CIPHER_OLD, PLAIN), configText(CIPHER_OLD, PLAIN, ' edited'))]),
    ).join('\n')
    expect(text).to.not.include(CIPHER_OLD)
    expect(text).to.not.include(PLAIN)
    expect(text).to.not.match(/^\s+[+-].*encrypted/m)
    expect(text).to.not.match(/^\s+[+-].*confidential \*/m)
    expect(text).to.include('+   "description": "plain edited"')
  })

  it('an added file masks every secret as [encrypted] and redacts confidential plaintext like the audit trail', () => {
    const text = renderShow(detail([file(null, configText(CIPHER_NEW, PLAIN))])).join('\n')
    expect(text).to.not.include(CIPHER_NEW)
    expect(text).to.not.include(PLAIN)
    expect(text).to.include('"value": "[encrypted]"')
    expect(text).to.include(`"value": "[confidential ${fp(PLAIN)}, ${PLAIN.length} chars]"`)
  })

  it('cr merge prints the same masked diff', () => {
    const text = renderMergeSummary(detail([file(configText(CIPHER_OLD, PLAIN), null)])).join('\n')
    expect(text).to.not.include(CIPHER_OLD)
    expect(text).to.not.include(PLAIN)
    expect(text).to.include('"value": "[encrypted]"')
  })

  it('keeps the file text as written: only the secret values change', () => {
    const before = configText(CIPHER_OLD, PLAIN)
    const masked = maskFile(file(before, null)).before!
    expect(masked).to.equal(
      before
        .replace(JSON.stringify(CIPHER_OLD), '"[encrypted]"')
        .replace(JSON.stringify(PLAIN), JSON.stringify(`[confidential ${fp(PLAIN)}, ${PLAIN.length} chars]`)),
    )
  })

  it('a secret value that is not a string falls back to masked, re-serialized JSON', () => {
    const text =
      '{"key":"j","default":{"rules":[{"value":{"type":"json","value":{"token":"s3cr3t-json"},"confidential":true}}]}}'
    const masked = maskFile(file(null, text)).after!
    expect(masked).to.not.include('s3cr3t-json')
    expect(JSON.parse(masked).default.rules[0].value.value).to.match(/^\[confidential \*{5}[\da-f]{5}, \d+ chars]$/)
  })

  it('leaves provided values, non-JSON files and secret-free files alone', () => {
    const provided =
      '{"value":{"type":"provided","value":{"source":"ENV_VAR","lookup":"API_KEY"},"confidential":true}}\n'
    expect(maskFile(file(null, provided)).after).to.equal(provided)
    expect(maskFile(file('not json', 'still not')).after).to.equal('still not')
    const plain = '{\n  "key": "checkout",\n  "value": true\n}\n'
    expect(maskFile(file(plain, plain)).before).to.equal(plain)
  })
})
