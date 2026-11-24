/**
 * The secrets writer: one commit through the existing `configs.push` route,
 * locked to the snapshot's HEAD (plan section 0, Q1). The server does not
 * accept secrets/ yet (app-quonfig qfg-mol-bkt), so the route is stubbed at
 * fetch; the real push hook validator runs on the tree the push would create.
 * Bead qfg-mol-hle PR 2.
 */
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

import {encrypt} from '../../src/secrets/qf1.js'
import {
  newSecretDocument,
  secretValue,
  serializeSecretDocument,
  setSecretScopeValue,
} from '../../src/secrets/secret-doc.js'
import {type WorkspaceSnapshot, cloneWorkspaceSnapshot} from '../../src/secrets/workspace-snapshot.js'
import {SecretWriteError, pushWorkspaceFiles, secretCommitMessage} from '../../src/secrets/write-secret.js'
import {readCommitTree} from '../../src/verify/standalone.js'
import {validateFileMap} from '../../src/verify/validate.js'
import {bareWorkspaceRepo, configDoc, git, quonfigJson, testKey, tmpDir} from './plumbing-fixtures.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const PLAINTEXT = 'SENTINEL-PLAINTEXT-plain-words-0123456789'
const key = testKey()
const prodKey = testKey()
const MANIFEST = quonfigJson({
  QUONFIG_KEYSET: {publicKeys: [key.publicEntry]},
  QUONFIG_KEYSET_PROD: {publicKeys: [prodKey.publicEntry]},
})

type Captured = {body: any; headers: Record<string, string>; url: string}

describe('pushWorkspaceFiles (qfg-mol-hle)', function () {
  this.timeout(30_000)
  const originalFetch = globalThis.fetch
  const saved = {
    apiKey: process.env.QUONFIG_API_KEY,
    domain: process.env.QUONFIG_DOMAIN,
    override: process.env.QUONFIG_API_BASE_URL_OVERRIDE,
  }
  let root: string
  let snap: WorkspaceSnapshot
  let headSha: string
  let calls: Captured[]

  const stub = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, url})
      const text = JSON.stringify(body)
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return JSON.parse(text) as unknown
        },
        async text() {
          return text
        },
      } as unknown as Response
    }) as typeof globalThis.fetch
  }

  const secretDocText = (k: string, keyset: 'QUONFIG_KEYSET' | 'QUONFIG_KEYSET_PROD' = 'QUONFIG_KEYSET') =>
    serializeSecretDocument(
      setSecretScopeValue(newSecretDocument(k), {
        value: secretValue(
          encrypt({
            keyset,
            plaintext: PLAINTEXT,
            recipient: keyset === 'QUONFIG_KEYSET' ? key.publicEntry : prodKey.publicEntry,
          }),
        ),
      }).document,
    )

  const write = (
    files: Parameters<typeof pushWorkspaceFiles>[0]['files'],
    message = secretCommitMessage({
      fingerprint: key.fingerprint,
      key: 'stripe.key',
      keyset: 'QUONFIG_KEYSET',
      verb: 'create',
    }),
  ) => pushWorkspaceFiles({files, message, orgSlug: 'acme', snapshot: snap, workspaceId: WORKSPACE_ID})

  async function refusalOf(p: Promise<unknown>): Promise<SecretWriteError> {
    try {
      await p
    } catch (error) {
      expect(error).to.be.instanceOf(SecretWriteError)
      return error as SecretWriteError
    }

    return expect.fail('expected a SecretWriteError')
  }

  beforeEach(async () => {
    process.env.QUONFIG_API_KEY = 'qf_uk_fake_for_test'
    process.env.QUONFIG_API_BASE_URL_OVERRIDE = 'https://app.example.test'
    delete process.env.QUONFIG_DOMAIN
    calls = []
    root = tmpDir('qfg-write-secret-test-')
    const repo = bareWorkspaceRepo(root, {
      'configs/Plain.Config.json': configDoc('Plain.Config'),
      'quonfig.json': MANIFEST,
      'secrets/db.password.json': secretDocText('db.password'),
    })
    headSha = repo.headSha
    snap = await cloneWorkspaceSnapshot(pathToFileURL(repo.bare).href, {tmpRoot: root})
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    for (const [k, v] of [
      ['QUONFIG_API_KEY', saved.apiKey],
      ['QUONFIG_API_BASE_URL_OVERRIDE', saved.override],
      ['QUONFIG_DOMAIN', saved.domain],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }

    await snap.cleanup()
    fs.rmSync(root, {force: true, maxRetries: 3, recursive: true})
  })

  it('sends one add delta to configs.push, locked to the snapshot HEAD', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const afterJson = secretDocText('stripe.key')
    const r = await write([{afterJson, path: 'secrets/stripe.key.json'}])
    expect(r).to.deep.equal({commitSha: 'c'.repeat(40)})
    expect(calls).to.have.length(1)
    expect(calls[0].url).to.equal('https://app.example.test/api/v1/configs/push')
    expect(calls[0].body).to.deep.equal({
      json: {
        expectedSha: headSha,
        files: [{afterJson, kind: 'add', path: 'secrets/stripe.key.json'}],
        message: `qfg: create secret stripe.key on QUONFIG_KEYSET ${key.fingerprint}`,
        workspaceId: WORKSPACE_ID,
      },
    })
    expect(snap.headSha).to.equal(headSha)
  })

  it('a change to an existing file is a modify whose beforeJson comes from the snapshot', async () => {
    stub(200, {json: {commitSha: 'd'.repeat(40)}})
    const afterJson = secretDocText('db.password', 'QUONFIG_KEYSET_PROD')
    await write(
      [{afterJson, path: 'secrets/db.password.json'}],
      secretCommitMessage({
        fingerprint: prodKey.fingerprint,
        key: 'db.password',
        keyset: 'QUONFIG_KEYSET_PROD',
        scope: 'production',
        verb: 'set',
      }),
    )
    const sent = calls[0].body.json
    expect(sent.files).to.deep.equal([
      {
        afterJson,
        beforeJson: snap.readFile('secrets/db.password.json'),
        kind: 'modify',
        path: 'secrets/db.password.json',
      },
    ])
    expect(sent.message).to.equal(
      `qfg: set secret db.password (production) on QUONFIG_KEYSET_PROD ${prodKey.fingerprint}`,
    )
  })

  it('a delete sends the snapshot content as beforeJson', async () => {
    stub(200, {json: {commitSha: 'e'.repeat(40)}})
    await write(
      [{delete: true, path: 'secrets/db.password.json'}],
      secretCommitMessage({key: 'db.password', verb: 'delete'}),
    )
    expect(calls[0].body.json.files).to.deep.equal([
      {beforeJson: snap.readFile('secrets/db.password.json'), kind: 'delete', path: 'secrets/db.password.json'},
    ])
    expect(calls[0].body.json.message).to.equal('qfg: delete secret db.password')
  })

  it('the request never carries the plaintext, its length or its last characters', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    await write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}])
    const wire = JSON.stringify(calls[0])
    expect(wire).to.not.include('SENTINEL')
    expect(wire).to.not.include(PLAINTEXT.slice(-4))
    expect(calls[0].body.json.message).to.not.match(/\d+ chars|length/)
  })

  it('maps 409 to the retry message', async () => {
    stub(409, {json: {message: 'workspace moved', status: 409}})
    const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
    expect(err.code).to.equal('conflict')
    expect(err.message).to.equal('the workspace changed while writing; nothing was written; run the command again')
  })

  it('maps 403 denials, naming path, reason and permission', async () => {
    stub(403, {
      json: {
        data: {
          denials: [
            {path: 'secrets/stripe.key.json', reason: 'protected', requiredPermission: 'configs.write.protected'},
          ],
        },
        message: 'forbidden',
      },
    })
    const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
    expect(err.code).to.equal('denied')
    expect(err.message).to.equal(
      'the server refused the write:\n  secrets/stripe.key.json: protected (needs configs.write.protected)',
    )
    expect(err.denials).to.have.length(1)
  })

  it('a server without secrets/ in its push allow-list gets a clear message', async () => {
    stub(400, {json: {message: 'Path not allowed by push allow-list: secrets/stripe.key.json'}})
    const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
    expect(err.code).to.equal('bad_request')
    expect(err.message).to.equal(
      'this Quonfig server does not accept secrets/ yet (Path not allowed by push allow-list: secrets/stripe.key.json)',
    )
  })

  describe('refuses before any request', () => {
    beforeEach(() => stub(200, {json: {commitSha: 'c'.repeat(40)}}))
    afterEach(() => expect(calls, 'no request may be sent').to.deep.equal([]))

    it('a path outside secrets/ (other than quonfig.json)', async () => {
      for (const p of [
        'configs/x.json',
        'secrets/a/b.json',
        'secrets/.x.json',
        'secrets/X.JSON',
        '../secrets/x.json',
      ]) {
        const err = await refusalOf(write([{afterJson: secretDocText('x'), path: p}]))
        expect(err.code, p).to.equal('invalid_input')
      }
    })

    it('a document of a forbidden shape (weighted value)', async () => {
      const doc = JSON.parse(secretDocText('stripe.key'))
      doc.default.rules[0].value = {type: 'weighted_values', value: {weightedValues: []}}
      const err = await refusalOf(write([{afterJson: JSON.stringify(doc, null, 2), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('invalid_input')
      expect(err.message).to.include('weighted_values')
    })

    it('a document whose key does not match its file name', async () => {
      const err = await refusalOf(write([{afterJson: secretDocText('other.key'), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('invalid_input')
    })

    it('a value on a keyset quonfig.json does not declare (the push hook would reject it)', async () => {
      const stranger = testKey()
      const doc = setSecretScopeValue(newSecretDocument('stripe.key'), {
        value: secretValue(encrypt({keyset: 'QUONFIG_KEYSET_OTHER', plaintext: 'x', recipient: stranger.publicEntry})),
      }).document
      const err = await refusalOf(write([{afterJson: serializeSecretDocument(doc), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('refused')
      expect(err.message).to.include('QUONFIG_KEYSET_OTHER is not declared in quonfig.json')
    })

    it('a key that already exists in another family (case-insensitive)', async () => {
      const err = await refusalOf(
        write([{afterJson: secretDocText('plain.config'), path: 'secrets/plain.config.json'}]),
      )
      expect(err.code).to.equal('refused')
    })

    it('a modify or delete of a file the snapshot does not hold, or an add of one it does, is decided from the snapshot', async () => {
      const err = await refusalOf(
        write([{delete: true, path: 'secrets/nope.json'}], secretCommitMessage({key: 'nope', verb: 'delete'})),
      )
      expect(err.code).to.equal('invalid_input')
    })

    it('no files', async () => {
      expect((await refusalOf(write([]))).code).to.equal('invalid_input')
    })

    it('a snapshot without a usable HEAD sha (the lock)', async () => {
      const broken = {...snap, headSha: ''} as WorkspaceSnapshot
      const err = await refusalOf(
        pushWorkspaceFiles({
          files: [{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}],
          message: secretCommitMessage({key: 'stripe.key', verb: 'delete'}),
          orgSlug: 'acme',
          snapshot: broken,
          workspaceId: WORKSPACE_ID,
        }),
      )
      expect(err.code).to.equal('invalid_input')
    })
  })

  it('secretCommitMessage accepts only well-formed names, so nothing else can reach the message', () => {
    expect(() => secretCommitMessage({fingerprint: 'zz', key: 'k', keyset: 'QUONFIG_KEYSET', verb: 'create'})).to.throw(
      SecretWriteError,
    )
    expect(() =>
      secretCommitMessage({fingerprint: key.fingerprint, key: 'k', keyset: 'HOME', verb: 'create'}),
    ).to.throw(SecretWriteError)
    expect(() => secretCommitMessage({key: 'k\nhunter2', verb: 'delete'})).to.throw(SecretWriteError)
    expect(() =>
      secretCommitMessage({
        key: 'k',
        keyset: 'QUONFIG_KEYSET',
        scope: 'prod uction',
        fingerprint: key.fingerprint,
        verb: 'set',
      }),
    ).to.throw(SecretWriteError)
    expect(() => secretCommitMessage({key: 'k', verb: 'create'} as never)).to.throw(SecretWriteError)
  })

  it('the tree the push would create passes the real push hook (readCommitTree + validateFileMap)', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const created = secretDocText('stripe.key', 'QUONFIG_KEYSET_PROD')
    const updated = secretDocText('db.password', 'QUONFIG_KEYSET')
    await write([
      {afterJson: created, path: 'secrets/stripe.key.json'},
      {afterJson: updated, path: 'secrets/db.password.json'},
    ])
    // Apply exactly what was sent onto the snapshot's commit, as the server would.
    for (const f of calls[0].body.json.files as Array<{afterJson: string; path: string}>) {
      fs.writeFileSync(path.join(snap.dir, f.path), f.afterJson)
    }

    git(snap.dir, 'add', '-A')
    git(snap.dir, 'commit', '-q', '-m', calls[0].body.json.message)
    const {files, quonfigJson: qj} = readCommitTree('HEAD', snap.dir)
    const result = validateFileMap(files, {quonfigJson: qj, validateValues: true})
    expect(result.issues.filter((i) => i.severity === 'error')).to.deep.equal([])
    expect([...files.keys()]).to.include.members(['secrets/stripe.key.json', 'secrets/db.password.json'])
    // Control: the same hook call does check secrets/ values (a value on an undeclared keyset fails).
    files.set('secrets/stripe.key.json', created.replaceAll('QUONFIG_KEYSET_PROD', 'QUONFIG_KEYSET_GONE'))
    const control = validateFileMap(files, {quonfigJson: qj, validateValues: true})
    expect(control.issues.map((i) => i.message).join('\n')).to.include('QUONFIG_KEYSET_GONE is not declared')
  })
})
