import {expect} from '@oclif/test'
import {describe, it} from 'mocha'

import {parseEnvFileContents, parseInlineEnvSpec} from '../../src/util/parse-run-env-spec.js'

/**
 * `qfg run` accepts env mappings in two forms:
 *
 *  1. Inline: `--env VAR=key.path`            (uses `=`, not `:` — matches docker -e)
 *  2. File:   one `VAR=key.path` per line     (no `qfg://` prefix in v1)
 *
 * Both share the same VAR=key.path grammar, so the parsing logic is one
 * function called from two places.
 */
describe('parseInlineEnvSpec', () => {
  it('parses VAR=key.path', () => {
    expect(parseInlineEnvSpec('DATABASE_URL=db.url')).to.deep.equal({varName: 'DATABASE_URL', configKey: 'db.url'})
  })

  it('allows dots, dashes, and underscores in the config key', () => {
    expect(parseInlineEnvSpec('AUTH_SECRET=auth.secret-v2.value')).to.deep.equal({
      varName: 'AUTH_SECRET',
      configKey: 'auth.secret-v2.value',
    })
  })

  it('rejects spec without =', () => {
    expect(() => parseInlineEnvSpec('DATABASE_URL')).to.throw(/expected VAR=key/)
  })

  it('rejects empty var name', () => {
    expect(() => parseInlineEnvSpec('=db.url')).to.throw(/empty/)
  })

  it('rejects empty config key', () => {
    expect(() => parseInlineEnvSpec('DATABASE_URL=')).to.throw(/empty/)
  })

  it('does NOT split on colons (the old prefab-style separator)', () => {
    // VAR:key.path used to be the prefab convention; we explicitly chose `=`
    // for docker-e parity. A colon is now invalid syntax.
    expect(() => parseInlineEnvSpec('DATABASE_URL:db.url')).to.throw(/expected VAR=key/)
  })

  it('preserves only the first = so config keys can theoretically contain = in the future', () => {
    // Future-proofing: split on FIRST `=` only.
    expect(parseInlineEnvSpec('FOO=a=b')).to.deep.equal({varName: 'FOO', configKey: 'a=b'})
  })
})

describe('parseEnvFileContents', () => {
  it('parses one mapping per line', () => {
    const result = parseEnvFileContents(['DATABASE_URL=db.url', 'AUTH_SECRET=auth.secret'].join('\n'))
    expect(result).to.deep.equal([
      {varName: 'DATABASE_URL', configKey: 'db.url'},
      {varName: 'AUTH_SECRET', configKey: 'auth.secret'},
    ])
  })

  it('skips blank lines and # comments', () => {
    const contents = ['# header comment', '', 'DATABASE_URL=db.url', '   ', '# AUTH_SECRET=db.url', 'X=y'].join('\n')
    expect(parseEnvFileContents(contents)).to.deep.equal([
      {varName: 'DATABASE_URL', configKey: 'db.url'},
      {varName: 'X', configKey: 'y'},
    ])
  })

  it('reports the line number on a malformed line', () => {
    const contents = ['DATABASE_URL=db.url', 'BROKEN_LINE_NO_EQUALS', 'X=y'].join('\n')
    expect(() => parseEnvFileContents(contents)).to.throw(/line 2/)
  })

  it('trims whitespace around VAR= and around the config key', () => {
    expect(parseEnvFileContents('  DATABASE_URL = db.url  ')).to.deep.equal([
      {varName: 'DATABASE_URL', configKey: 'db.url'},
    ])
  })
})
