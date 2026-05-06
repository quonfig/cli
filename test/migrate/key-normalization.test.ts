import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {LegacyChange, MigrationSource, QuonfigFile} from '../../src/migrate/source.js'

import {MigratorKeyCollisionError, writeQuonfigFiles} from '../../src/migrate/local-write.js'
import {getOutputPath, normalizeKey} from '../../src/migrate/sources/launch/translate.js'

describe('normalizeKey (qfg-qhk1)', () => {
  it('replaces / with . to make keys flat-file safe', () => {
    expect(normalizeKey('foo/bar')).to.equal('foo.bar')
    expect(normalizeKey('a/b/c')).to.equal('a.b.c')
  })

  it('passes through keys with no /', () => {
    expect(normalizeKey('foo.bar')).to.equal('foo.bar')
    expect(normalizeKey('plain-key')).to.equal('plain-key')
  })
})

describe('getOutputPath (qfg-qhk1)', () => {
  it('emits a flat path for a feature_flag key with /', () => {
    expect(getOutputPath('feature_flag', 'patient.faq.account')).to.equal('feature-flags/patient.faq.account.json')
    expect(getOutputPath('feature_flag', 'patient.faq.account/legacy')).to.equal(
      'feature-flags/patient.faq.account.legacy.json',
    )
  })

  it('emits a flat path for a config key with /', () => {
    expect(getOutputPath('config', 'patient.faq.account/billing')).to.equal('configs/patient.faq.account.billing.json')
  })

  it('never produces a nested path even from a deeply-slashed source key', () => {
    const out = getOutputPath('feature_flag', 'a/b/c/d')
    expect(out).to.equal('feature-flags/a.b.c.d.json')
    expect(out.split('/').length).to.equal(2)
  })
})

const fakeSource = (translated: Record<string, QuonfigFile[]>): MigrationSource => ({
  async *fetchChanges() {
    /* unused */
  },
  async listEnvironments() {
    return []
  },
  name: 'fake',
  translate(change: LegacyChange): QuonfigFile[] {
    return translated[change.key ?? ''] ?? []
  },
  async validateAuth() {},
})

describe('writeQuonfigFiles (qfg-qhk1)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-qhk1-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {force: true, recursive: true})
  })

  it('refuses to write nested paths emitted from a buggy translate()', () => {
    const source = fakeSource({
      'patient.faq.account/legacy': [{contents: '{}', path: 'feature-flags/patient.faq.account/legacy.json'}],
    })
    const changes: LegacyChange[] = [{key: 'patient.faq.account/legacy', raw: {}, source: 'fake'}]
    expect(() => writeQuonfigFiles(dir, changes, source)).to.throw(/refusing to write nested path/i)
  })

  it('throws MigratorKeyCollisionError when two distinct source keys collide on the same destination after normalization', () => {
    const source = fakeSource({
      'foo/bar': [{contents: '{"k":"foo/bar"}', path: 'feature-flags/foo.bar.json'}],
      'foo.bar': [{contents: '{"k":"foo.bar"}', path: 'feature-flags/foo.bar.json'}],
    })
    const changes: LegacyChange[] = [
      {key: 'foo/bar', raw: {}, source: 'fake'},
      {key: 'foo.bar', raw: {}, source: 'fake'},
    ]
    expect(() => writeQuonfigFiles(dir, changes, source)).to.throw(MigratorKeyCollisionError)
  })

  it('allows multiple changes with the SAME source key to write the same path (incremental edits)', () => {
    const source = fakeSource({
      'flag-a': [{contents: '{"v":2}', path: 'feature-flags/flag-a.json'}],
    })
    const changes: LegacyChange[] = [
      {key: 'flag-a', raw: {}, source: 'fake'},
      {key: 'flag-a', raw: {}, source: 'fake'},
    ]
    expect(() => writeQuonfigFiles(dir, changes, source)).to.not.throw()
    expect(fs.readFileSync(path.join(dir, 'feature-flags/flag-a.json'), 'utf8')).to.equal('{"v":2}')
  })
})
