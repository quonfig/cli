/**
 * Building `secrets/<key>.json` documents (spec 10.2, decision 24) and the
 * proof that everything this module can produce passes the push hook's
 * validator (spec 11). Bead qfg-mol-hle PR 2.
 */
import {expect} from 'chai'

import {encrypt} from '../../src/secrets/qf1.js'
import {
  SecretDocumentError,
  assertWritableSecretDocument,
  inheritedKeyset,
  newSecretDocument,
  parseSecretDocument,
  secretPath,
  secretValue,
  secretValuesOf,
  serializeSecretDocument,
  setSecretScopeValue,
} from '../../src/secrets/secret-doc.js'
import {validateFileMap} from '../../src/verify/validate.js'
import {configDoc, quonfigJson, testKey} from './plumbing-fixtures.js'

const ka = testKey()
const kb = testKey()
const MANIFEST = quonfigJson({
  QUONFIG_KEYSET: {publicKeys: [ka.publicEntry]},
  QUONFIG_KEYSET_PROD: {publicKeys: [kb.publicEntry]},
})
const valueOn = (keyset: 'QUONFIG_KEYSET' | 'QUONFIG_KEYSET_PROD', plaintext = 's3cret') =>
  secretValue(encrypt({keyset, plaintext, recipient: keyset === 'QUONFIG_KEYSET' ? ka.publicEntry : kb.publicEntry}))

/** Run the push hook's validator exactly as the hook does (validateFileMap + quonfigJson option). */
function hookIssues(files: Record<string, string>, manifest = MANIFEST): string[] {
  const result = validateFileMap(new Map(Object.entries(files)), {quonfigJson: manifest, validateValues: true})
  return result.issues.filter((i) => i.severity === 'error').map((i) => `${i.file}: ${i.message}`)
}

const targetingRule = (value: unknown) => ({
  criteria: [
    {operator: 'PROP_IS_ONE_OF', propertyName: 'user.key', valueToMatch: {type: 'string_list', value: ['u1']}},
  ],
  value,
})

function refusal(fn: () => unknown): SecretDocumentError {
  try {
    fn()
  } catch (error) {
    expect(error).to.be.instanceOf(SecretDocumentError)
    return error as SecretDocumentError
  }

  return expect.fail('expected a SecretDocumentError')
}

describe('secret documents (spec 10.2, qfg-mol-hle)', () => {
  it('newSecretDocument has the spec 10.2 shape, in order', () => {
    const doc = newSecretDocument('stripe.webhook.secret')
    expect(Object.keys(doc)).to.deep.equal([
      '$schema',
      'key',
      'type',
      'valueType',
      'sendToClientSdk',
      'access',
      'tags',
      'default',
      'environments',
      'variants',
    ])
    expect(doc).to.deep.equal({
      $schema: 'https://api.quonfig.com/schemas/v1/stored-config.json',
      access: 'standard',
      default: {rules: []},
      environments: [],
      key: 'stripe.webhook.secret',
      sendToClientSdk: false,
      tags: [],
      type: 'secret',
      valueType: 'string',
      variants: [],
    })
  })

  it('newSecretDocument takes the access tier the caller resolved', () => {
    expect(newSecretDocument('a.b', {access: 'protected-env'}).access).to.equal('protected-env')
  })

  it('refuses keys the hook would refuse, before building a path', () => {
    for (const bad of ['', 'a/b', '../quonfig', 'new', 'con', 'trailing.', 'sp ace', 'x'.repeat(201)]) {
      expect(refusal(() => secretPath(bad)).message, bad).to.match(/^cannot write secret key/)
      expect(refusal(() => newSecretDocument(bad)).message, bad).to.match(/^cannot write secret key/)
    }

    expect(secretPath('stripe.webhook.secret')).to.equal('secrets/stripe.webhook.secret.json')
  })

  it('secretValue wraps only a well-formed qf1 string, always confidential', () => {
    const v = valueOn('QUONFIG_KEYSET')
    expect(Object.keys(v)).to.deep.equal(['type', 'value', 'confidential'])
    expect(v.type).to.equal('string')
    expect(v.confidential).to.equal(true)
    for (const bad of ['plaintext', 'qf1:HOME:00000000:AAAA', 'qf2:x', '']) {
      expect(refusal(() => secretValue(bad)).message).to.match(/^a secret value must be a qf1 string/)
    }

    expect(refusal(() => secretValue('SENTINEL-PLAINTEXT-123')).message).to.not.include('SENTINEL')
  })

  it('a new secret with a default fallback passes the push hook', () => {
    const {document} = setSecretScopeValue(newSecretDocument('stripe.webhook.secret'), {
      value: valueOn('QUONFIG_KEYSET'),
    })
    expect(document.default.rules).to.deep.equal([
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: document.default.rules[0].value},
    ])
    expect(hookIssues({'secrets/stripe.webhook.secret.json': serializeSecretDocument(document)})).to.deep.equal([])
  })

  it('setting an environment fallback keeps its targeting rules and passes the hook', () => {
    const base = setSecretScopeValue(newSecretDocument('db.password'), {value: valueOn('QUONFIG_KEYSET')}).document
    const targeted = {
      ...base,
      environments: [
        {
          id: 'production',
          rules: [
            targetingRule(valueOn('QUONFIG_KEYSET_PROD', 't')),
            {criteria: [{operator: 'ALWAYS_TRUE'}], value: valueOn('QUONFIG_KEYSET_PROD', 'old')},
          ],
        },
      ],
    }
    const next = valueOn('QUONFIG_KEYSET_PROD', 'new')
    const r = setSecretScopeValue(targeted, {envName: 'production', value: next})
    expect(r.keptTargeting).to.equal(1)
    expect(r.replacedTargeting).to.equal(0)
    expect(r.seeded).to.equal(false)
    const rules = r.document.environments[0].rules!
    expect(rules).to.have.length(2)
    expect(rules[0]).to.deep.equal(targeted.environments[0].rules[0])
    expect(rules[1].value).to.deep.equal(next)
    expect(targeted.environments[0].rules[1].value, 'input not mutated').to.not.deep.equal(next)
    expect(hookIssues({'secrets/db.password.json': serializeSecretDocument(r.document)})).to.deep.equal([])
  })

  it('replaceTargeting collapses the scope to one fallback', () => {
    const doc = {
      ...newSecretDocument('db.password'),
      default: {
        rules: [
          targetingRule(valueOn('QUONFIG_KEYSET')),
          {criteria: [{operator: 'ALWAYS_TRUE'}], value: valueOn('QUONFIG_KEYSET')},
        ],
      },
    }
    const value = valueOn('QUONFIG_KEYSET')
    const r = setSecretScopeValue(doc, {replaceTargeting: true, value})
    expect(r.document.default.rules).to.deep.equal([{criteria: [{operator: 'ALWAYS_TRUE'}], value}])
    expect(r.replacedTargeting).to.equal(1)
    expect(hookIssues({'secrets/db.password.json': serializeSecretDocument(r.document)})).to.deep.equal([])
  })

  it('an environment with no rules of its own is seeded from default', () => {
    const doc = {
      ...newSecretDocument('db.password'),
      default: {
        rules: [
          targetingRule(valueOn('QUONFIG_KEYSET')),
          {criteria: [{operator: 'ALWAYS_TRUE'}], value: valueOn('QUONFIG_KEYSET')},
        ],
      },
    }
    const value = valueOn('QUONFIG_KEYSET_PROD')
    const r = setSecretScopeValue(doc, {envName: 'staging', value})
    expect(r.seeded).to.equal(true)
    expect(r.keptTargeting).to.equal(1)
    expect(r.document.environments).to.have.length(1)
    expect(r.document.environments[0].id).to.equal('staging')
    expect(r.document.environments[0].rules![1].value).to.deep.equal(value)
    expect(r.document.default).to.deep.equal(doc.default)
    expect(hookIssues({'secrets/db.password.json': serializeSecretDocument(r.document)})).to.deep.equal([])
  })

  it('refuses the reserved scope name "default" and, given the workspace environments, an unknown one', () => {
    const doc = newSecretDocument('db.password')
    const value = valueOn('QUONFIG_KEYSET')
    for (const envName of ['default', '']) {
      expect(refusal(() => setSecretScopeValue(doc, {envName, value})).message).to.include('not an environment name')
    }

    const environments = ['production', 'staging']
    expect(refusal(() => setSecretScopeValue(doc, {envName: 'prod', environments, value})).message).to.equal(
      '"prod" is not an environment of this workspace (production, staging)',
    )
    expect(setSecretScopeValue(doc, {envName: 'staging', environments, value}).document.environments[0].id).to.equal(
      'staging',
    )
    expect(
      setSecretScopeValue(doc, {envName: 'qa', value}).document.environments[0].id,
      'no list: not checked',
    ).to.equal('qa')
  })

  it('secretValuesOf lists every rule value with its scope, index, keyset and fingerprint', () => {
    const d = valueOn('QUONFIG_KEYSET')
    const p = valueOn('QUONFIG_KEYSET_PROD')
    const doc = {
      ...newSecretDocument('db.password'),
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: d}]},
      environments: [{id: 'production', rules: [targetingRule(p), {criteria: [], value: p}]}],
    }
    expect(secretValuesOf(doc)).to.deep.equal([
      {fingerprint: ka.fingerprint, keyset: 'QUONFIG_KEYSET', ruleIndex: 0, scope: 'default', value: d.value},
      {fingerprint: kb.fingerprint, keyset: 'QUONFIG_KEYSET_PROD', ruleIndex: 0, scope: 'production', value: p.value},
      {fingerprint: kb.fingerprint, keyset: 'QUONFIG_KEYSET_PROD', ruleIndex: 1, scope: 'production', value: p.value},
    ])
  })

  it('serialization matches the server (JSON.stringify, 2 spaces, no trailing newline) and round-trips', () => {
    const {document} = setSecretScopeValue(newSecretDocument('a.b'), {value: valueOn('QUONFIG_KEYSET')})
    const text = serializeSecretDocument(document)
    expect(text).to.equal(JSON.stringify(document, null, 2))
    expect(text.endsWith('}')).to.equal(true)
    expect(parseSecretDocument(text, 'a.b')).to.deep.equal(document)
  })

  it('parseSecretDocument refuses a document that is not this secret', () => {
    expect(refusal(() => parseSecretDocument('{', 'a.b')).message).to.equal('secrets/a.b.json is not valid JSON')
    expect(refusal(() => parseSecretDocument(configDoc('a.b'), 'a.b')).message).to.include('type "config"')
    const other = serializeSecretDocument(newSecretDocument('c.d'))
    expect(refusal(() => parseSecretDocument(other, 'a.b')).message).to.include('key "c.d"')
  })
})

describe('the writer can never produce a shape spec 10.2 / decision 24 forbids (qfg-mol-hle)', () => {
  const good = () =>
    setSecretScopeValue(newSecretDocument('db.password'), {value: valueOn('QUONFIG_KEYSET')}).document as Record<
      string,
      any
    >
  const cases: Array<[string, (d: Record<string, any>) => void, RegExp]> = [
    [
      'weighted value',
      (d) => {
        d.default.rules[0].value = {type: 'weighted_values', value: {weightedValues: []}}
      },
      /weighted_values/,
    ],
    [
      'provided value',
      (d) => {
        d.default.rules[0].value = {type: 'provided', value: {source: 'ENV_VAR', lookup: 'X'}}
      },
      /provided/,
    ],
    [
      'variants',
      (d) => {
        d.variants = [{value: d.default.rules[0].value}]
      },
      /variants/,
    ],
    [
      'sendToClientSdk true',
      (d) => {
        d.sendToClientSdk = true
      },
      /sendToClientSdk/,
    ],
    [
      'decryptWith',
      (d) => {
        d.default.rules[0].value.decryptWith = 'x'
      },
      /decryptWith/,
    ],
    [
      'confidential false',
      (d) => {
        d.default.rules[0].value.confidential = false
      },
      /confidential/,
    ],
    [
      'plaintext string',
      (d) => {
        d.default.rules[0].value.value = 'hunter2-SENTINEL'
      },
      /qf1 string/,
    ],
    [
      'qf1 in a variant-less env rule with a bad keyset',
      (d) => {
        d.environments = [
          {
            id: 'production',
            rules: [{criteria: [], value: {type: 'string', value: 'qf1:HOME:00000000:AAAA', confidential: true}}],
          },
        ]
      },
      /qf1 string/,
    ],
    [
      'type config',
      (d) => {
        d.type = 'config'
      },
      /type "secret"/,
    ],
    [
      'valueType json',
      (d) => {
        d.valueType = 'json'
      },
      /valueType "string"/,
    ],
    [
      'non-string type',
      (d) => {
        d.default.rules[0].value = {type: 'int', value: 3, confidential: true}
      },
      /type "string"/,
    ],
  ]

  for (const [name, mutate, re] of cases) {
    it(`refuses ${name}, in assertWritableSecretDocument and in serializeSecretDocument`, () => {
      const d = good()
      mutate(d)
      expect(refusal(() => assertWritableSecretDocument(d)).message).to.match(re)
      expect(refusal(() => serializeSecretDocument(d as never)).message).to.match(re)
      expect(refusal(() => serializeSecretDocument(d as never)).message).to.not.include('SENTINEL')
    })
  }

  it('sendToClientSdk, variants and environments absent are fine, as for the hook', () => {
    const d = good()
    delete d.sendToClientSdk
    delete d.variants
    delete d.environments
    expect(() => assertWritableSecretDocument(d)).to.not.throw()
    expect(hookIssues({'secrets/db.password.json': serializeSecretDocument(d as never)})).to.deep.equal([])
  })

  it('every refused shape is also one the push hook rejects (the writer is never looser than the hook)', () => {
    for (const [name, mutate] of cases) {
      const d = good()
      mutate(d)
      expect(hookIssues({'secrets/db.password.json': JSON.stringify(d, null, 2)}), name).to.not.deep.equal([])
    }
  })
})

describe('inheritedKeyset (plan 3.2 rule 3, qfg-mol-hle)', () => {
  const fallback = (value: unknown) => ({criteria: [{operator: 'ALWAYS_TRUE'}], value})

  it('the scope catch-all value decides', () => {
    const doc = {
      ...newSecretDocument('k'),
      default: {rules: [fallback(valueOn('QUONFIG_KEYSET'))]},
      environments: [
        {id: 'production', rules: [targetingRule(valueOn('QUONFIG_KEYSET')), fallback(valueOn('QUONFIG_KEYSET_PROD'))]},
      ],
    }
    expect(inheritedKeyset(doc)).to.equal('QUONFIG_KEYSET')
    expect(inheritedKeyset(doc, 'production')).to.equal('QUONFIG_KEYSET_PROD')
  })

  it('a scope seeded from default inherits the default fallback keyset', () => {
    const doc = {
      ...newSecretDocument('k'),
      default: {rules: [fallback(valueOn('QUONFIG_KEYSET_PROD'))]},
      environments: [{id: 'production', rules: [fallback(valueOn('QUONFIG_KEYSET'))]}],
    }
    expect(inheritedKeyset(doc, 'staging')).to.equal('QUONFIG_KEYSET_PROD')
  })

  it('an empty position falls back to the single keyset the document uses', () => {
    const doc = {
      ...newSecretDocument('k'),
      default: {rules: [targetingRule(valueOn('QUONFIG_KEYSET_PROD'))]},
      environments: [{id: 'production', rules: [targetingRule(valueOn('QUONFIG_KEYSET_PROD'))]}],
    }
    expect(inheritedKeyset(doc, 'production')).to.equal('QUONFIG_KEYSET_PROD')
  })

  it('an empty position in a document with mixed keysets inherits nothing', () => {
    const doc = {
      ...newSecretDocument('k'),
      default: {rules: [targetingRule(valueOn('QUONFIG_KEYSET_PROD'))]},
      environments: [{id: 'production', rules: [targetingRule(valueOn('QUONFIG_KEYSET'))]}],
    }
    expect(inheritedKeyset(doc, 'production')).to.equal(undefined)
  })

  it('a brand-new document inherits nothing', () => {
    expect(inheritedKeyset(newSecretDocument('k'))).to.equal(undefined)
    expect(inheritedKeyset(newSecretDocument('k'), 'production')).to.equal(undefined)
  })
})
