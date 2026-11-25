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
import {
  SnapshotPathError,
  type WorkspaceSnapshot,
  cloneWorkspaceSnapshot,
} from '../../src/secrets/workspace-snapshot.js'
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
    expect(sent.message).to.equal(`qfg: set secret db.password on QUONFIG_KEYSET_PROD ${prodKey.fingerprint}`)
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

  it('maps the stale-base 409 to the retry message', async () => {
    stub(409, {json: {message: 'Workspace HEAD moved (expected a, got b). Run `qfg pull` and retry.', status: 409}})
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
      const err = await refusalOf(
        write(
          [{afterJson: serializeSecretDocument(doc), path: 'secrets/stripe.key.json'}],
          secretCommitMessage({
            fingerprint: stranger.fingerprint,
            key: 'stripe.key',
            keyset: 'QUONFIG_KEYSET_OTHER',
            verb: 'create',
          }),
        ),
      )
      expect(err.code).to.equal('refused')
      expect(err.message).to.include('QUONFIG_KEYSET_OTHER is not declared in quonfig.json')
    })

    it('a key that already exists in another family (case-insensitive)', async () => {
      const err = await refusalOf(
        write(
          [{afterJson: secretDocText('plain.config'), path: 'secrets/plain.config.json'}],
          secretCommitMessage({
            fingerprint: key.fingerprint,
            key: 'plain.config',
            keyset: 'QUONFIG_KEYSET',
            verb: 'create',
          }),
        ),
      )
      expect(err.code).to.equal('refused')
    })

    it('a modify or delete of a file the snapshot does not hold, or an add of one it does, is decided from the snapshot', async () => {
      const err = await refusalOf(
        write([{delete: true, path: 'secrets/nope.json'}], secretCommitMessage({key: 'nope', verb: 'delete'})),
      )
      expect(err.code).to.equal('invalid_input')
    })

    it('a delete of quonfig.json (the workspace manifest is only ever modified)', async () => {
      const err = await refusalOf(
        write([{delete: true, path: 'quonfig.json'}], secretCommitMessage({key: 'db.password', verb: 'delete'})),
      )
      expect(err.code).to.equal('invalid_input')
      expect(err.message).to.equal('quonfig.json cannot be deleted')
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

  it('ignores a lock, kind or beforeJson the caller tries to supply: the request carries the snapshot values', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const afterJson = secretDocText('db.password', 'QUONFIG_KEYSET_PROD')
    await pushWorkspaceFiles({
      expectedSha: 'f'.repeat(40),
      files: [{afterJson, beforeJson: '{"forged":true}', kind: 'add', path: 'secrets/db.password.json'}],
      message: secretCommitMessage({
        fingerprint: prodKey.fingerprint,
        key: 'db.password',
        keyset: 'QUONFIG_KEYSET_PROD',
        verb: 'set',
      }),
      orgSlug: 'acme',
      snapshot: snap,
      workspaceId: WORKSPACE_ID,
    } as never)
    const sent = calls[0].body.json
    expect(sent.expectedSha).to.equal(headSha)
    expect(sent.files).to.deep.equal([
      {
        afterJson,
        beforeJson: snap.readFile('secrets/db.password.json'),
        kind: 'modify',
        path: 'secrets/db.password.json',
      },
    ])
  })

  it('a quonfig.json write is refused today: no message kind describes it (keyset commands come later)', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const m = JSON.parse(MANIFEST)
    delete m.secrets.keysets.QUONFIG_KEYSET_PROD
    for (const files of [
      [{afterJson: JSON.stringify(m, null, 2), path: 'quonfig.json'}],
      [
        {afterJson: JSON.stringify(m, null, 2), path: 'quonfig.json'},
        {afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'},
      ],
    ]) {
      const err = await refusalOf(write(files))
      expect(err.code).to.equal('invalid_input')
      expect(err.message).to.match(/^the commit message does not describe this write/)
    }

    expect(calls).to.deep.equal([])
  })

  it('pre-existing errors in other families do not block a secrets-only write', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const repo = bareWorkspaceRepo(path.join(root, 'broken'), {
      'feature-flags/broken.json': '{"key": "broken", "type": "nonsense"}',
      'quonfig.json': MANIFEST,
    })
    const other = await cloneWorkspaceSnapshot(pathToFileURL(repo.bare).href, {tmpRoot: root})
    try {
      await pushWorkspaceFiles({
        files: [{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}],
        message: secretCommitMessage({
          fingerprint: key.fingerprint,
          key: 'stripe.key',
          keyset: 'QUONFIG_KEYSET',
          verb: 'create',
        }),
        orgSlug: 'acme',
        snapshot: other,
        workspaceId: WORKSPACE_ID,
      })
      expect(calls).to.have.length(1)
      // Control: the broken file really is an error the hook reports.
      const issues = validateFileMap(other.documents(), {quonfigJson: MANIFEST, validateValues: true}).issues
      expect(issues.some((i) => i.severity === 'error' && i.file === 'feature-flags/broken.json')).to.equal(true)
    } finally {
      await other.cleanup()
    }
  })

  it('a write of two secret files is refused: the message names exactly one', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const err = await refusalOf(
      write([
        {afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'},
        {afterJson: secretDocText('other.key'), path: 'secrets/other.key.json'},
      ]),
    )
    expect(err.message).to.match(/^the commit message does not describe this write/)
    expect(calls).to.deep.equal([])
  })

  it('the same path twice in one write is refused before any request', async () => {
    stub(200, {json: {commitSha: 'c'.repeat(40)}})
    const afterJson = secretDocText('stripe.key')
    const err = await refusalOf(
      write([
        {afterJson, path: 'secrets/stripe.key.json'},
        {afterJson, path: 'secrets/stripe.key.json'},
      ]),
    )
    expect(err.code).to.equal('invalid_input')
    expect(err.message).to.include('listed twice')
    expect(calls).to.deep.equal([])
  })

  describe('the commit message is checked at run time', () => {
    beforeEach(() => stub(200, {json: {commitSha: 'c'.repeat(40)}}))
    afterEach(() => expect(calls, 'no request may be sent').to.deep.equal([]))
    const files = () => [{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]

    it('an unknown verb carrying text is refused', () => {
      expect(() =>
        secretCommitMessage({
          fingerprint: key.fingerprint,
          key: 'k',
          keyset: 'QUONFIG_KEYSET',
          verb: 'x\nPLAINTEXT',
        } as never),
      ).to.throw(SecretWriteError, /unknown verb/)
      expect(() => secretCommitMessage({key: 'k', verb: 'x\nPLAINTEXT'} as never)).to.throw(SecretWriteError)
    })

    for (const [name, message] of [
      ['a free-text string', 'qfg: set secret stripe.key to hunter2'],
      ['undefined', undefined],
      ['a forged message object', Object.freeze({text: 'qfg: create secret stripe.key hunter2'})],
    ] as const) {
      it(`pushWorkspaceFiles refuses ${name} as the message`, async () => {
        const err = await refusalOf(
          pushWorkspaceFiles({
            files: files(),
            message: message as never,
            orgSlug: 'acme',
            snapshot: snap,
            workspaceId: WORKSPACE_ID,
          }),
        )
        expect(err.code).to.equal('invalid_input')
        expect(err.message).to.equal('the commit message must come from secretCommitMessage')
      })
    }
  })

  describe('statuses callConfigsPush does not map become SecretWriteError, without tokens or values', () => {
    const LEAKY = `Bearer qf_uk_SENTINEL_TOKEN https://u:SENTINELPAT@gitea.example/x.git qf1:QUONFIG_KEYSET:${key.fingerprint}:SENTINELCIPHER`
    for (const [status, code, body] of [
      [422, 'hook_rejected', {json: {message: `hook said no ${LEAKY}`}}],
      [500, 'server_error', {json: {message: `boom ${LEAKY}`}}],
      [503, 'server_error', 'upstream down'],
      [401, 'unauthorized', {json: {message: `expired ${LEAKY}`}}],
      [403, 'denied', {json: {message: `no tier ${LEAKY}`}}],
    ] as const) {
      it(`HTTP ${status} -> ${code}`, async () => {
        stub(status, body)
        const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
        expect(err.code).to.equal(code)
        expect(err.message).to.include(`HTTP ${status}`)
        expect(err.message).to.not.match(/SENTINEL_TOKEN|SENTINELPAT|SENTINELCIPHER/)
      })
    }

    const UNKNOWN =
      'the result is unknown: the write may or may not have been applied; check with `qfg info stripe.key` (or the app) before retrying'
    const stripe = () => write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}])

    for (const [label, error] of [
      ['the connection drops after sending (commit may have landed)', new TypeError('fetch failed')],
      ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ] as const) {
      it(`${label} -> unknown_result, never "did not reach the server"`, async () => {
        globalThis.fetch = (async () => {
          throw error
        }) as typeof globalThis.fetch
        const err = await refusalOf(stripe())
        expect(err.code).to.equal('unknown_result')
        expect(err.message).to.include(UNKNOWN)
        expect(err.message).to.not.match(/nothing was written|did not reach/)
      })
    }

    it('a 200 with a non-JSON body, or without a commit sha -> "answered 200 but returned no commit"', async () => {
      for (const body of ['<html>ok</html>', {json: {}}]) {
        if (typeof body === 'string') {
          globalThis.fetch = (async () => ({ok: true, status: 200, text: async () => body})) as never
        } else stub(200, body)
        const err = await refusalOf(stripe())
        expect(err.code).to.equal('unknown_result')
        expect(err.message).to.equal(`the server answered 200 but returned no commit: ${UNKNOWN}`)
      }
    })

    for (const status of [404, 426, 500, 502]) {
      it(`HTTP ${status} says what the server answered and that the result is unknown`, async () => {
        stub(status, {json: {message: 'nope'}})
        const err = await refusalOf(stripe())
        expect(err.message).to.match(new RegExp(`^the server answered HTTP ${status}: `))
        expect(err.message).to.include(UNKNOWN)
        expect(err.message).to.not.include('nothing was written')
      })
    }

    it('a 403 without denials does not claim a permission problem with the secret', async () => {
      stub(403, {json: {message: 'Billing is not active'}})
      const err = await refusalOf(stripe())
      expect(err.code).to.equal('denied')
      expect(err.denials).to.deep.equal([])
      expect(err.message).to.equal(
        'the server refused the request (HTTP 403): configs.push failed (HTTP 403): Billing is not active',
      )
    })

    it('a tier denial is code denied and names the path, reason and permission', async () => {
      stub(403, {
        json: {
          data: {
            denials: [
              {
                path: 'secrets/stripe.key.json',
                reason: 'access tier protected-env requires',
                requiredPermission: 'configs.access.protected-env',
              },
            ],
          },
          message: 'forbidden',
        },
      })
      const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('denied')
      expect(err.denials![0].requiredPermission).to.equal('configs.access.protected-env')
      expect(err.message).to.include('protected-env')
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
    await write(
      [{afterJson: created, path: 'secrets/stripe.key.json'}],
      secretCommitMessage({
        fingerprint: prodKey.fingerprint,
        key: 'stripe.key',
        keyset: 'QUONFIG_KEYSET_PROD',
        verb: 'create',
      }),
    )
    // The snapshot is never checked out; check out its commit, apply exactly what was sent, as the server would.
    git(snap.dir, 'checkout', '-q', '-f', 'HEAD', '--', '.')
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
  describe('fix round of the PR 3a validation (qfg-mol-hle)', () => {
    const create = (k: string, ks: 'QUONFIG_KEYSET' | 'QUONFIG_KEYSET_PROD' = 'QUONFIG_KEYSET', scope?: string) =>
      secretCommitMessage({
        fingerprint: ks === 'QUONFIG_KEYSET' ? key.fingerprint : prodKey.fingerprint,
        key: k,
        keyset: ks,
        scope,
        verb: 'create',
      })

    it('N1: the message keyset, key fingerprint and scope must match the document sent', async () => {
      stub(200, {json: {commitSha: 'c'.repeat(40)}})
      const doc = secretDocText('stripe.key', 'QUONFIG_KEYSET')
      for (const message of [
        create('stripe.key', 'QUONFIG_KEYSET_PROD'),
        create('stripe.key', 'QUONFIG_KEYSET', 'production'),
      ]) {
        const err = await refusalOf(write([{afterJson: doc, path: 'secrets/stripe.key.json'}], message))
        expect(err.message, message.text).to.match(/^the commit message does not describe this write: .* has no /)
      }

      expect(calls).to.deep.equal([])
    })

    it('N1: a modify that does not change the file is refused', async () => {
      stub(200, {json: {commitSha: 'c'.repeat(40)}})
      const same = snap.readFile('secrets/db.password.json')!
      const err = await refusalOf(
        write(
          [{afterJson: same, path: 'secrets/db.password.json'}],
          secretCommitMessage({
            fingerprint: key.fingerprint,
            key: 'db.password',
            keyset: 'QUONFIG_KEYSET',
            verb: 'set',
          }),
        ),
      )
      expect(err.message).to.include('would not change')
      expect(calls).to.deep.equal([])
    })

    it('N2: the files, each change and its content are read once; what was checked is what is sent', async () => {
      stub(200, {json: {commitSha: 'c'.repeat(40)}})
      const good = secretDocText('stripe.key')
      let reads = 0
      const change = {
        get afterJson() {
          reads++
          return reads === 1 ? good : '{"key":"stripe.key","forged":true}'
        },
        path: 'secrets/stripe.key.json',
      }
      await write([change as never], create('stripe.key'))
      expect(calls[0].body.json.files[0].afterJson).to.equal(good)
      expect(reads).to.equal(1)
    })

    it('N4: error.denials holds the scrubbed, capped list, not the raw server list', async () => {
      const LEAKS = `qf1:QUONFIG_KEYSET:${key.fingerprint}:RAWCIPHERTEXT https://u:RAWTOKEN@x.example/y`
      stub(403, {
        json: {
          data: {
            denials: Array.from({length: 30}, (_, i) => ({
              path: `secrets/s${i}.json ${LEAKS}`,
              reason: 'tier',
              requiredPermission: 'p',
            })),
          },
        },
      })
      const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(err.denials).to.have.length(20)
      expect(JSON.stringify(err.denials)).to.not.match(/RAWCIPHERTEXT|RAWTOKEN/)
      expect(err.message).to.include('... and 10 more')
      expect(err.message.split('\n')).to.have.length(22)
    })

    it('N6: a 409 that is not a stale base does not say the workspace changed', async () => {
      stub(409, {json: {message: 'Could not read the current contents of secrets/stripe.key.json'}})
      const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('conflict')
      expect(err.message).to.equal(
        'the server refused the write as a conflict (HTTP 409): Could not read the current contents of secrets/stripe.key.json; nothing was written',
      )
    })

    it('N6/N11: an empty 400 has no dangling colon; only the allow-list 400 says secrets/ is not supported', async () => {
      stub(400, {json: {message: ''}})
      const empty = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(empty.message).to.equal('the server refused the write (HTTP 400)')
      stub(400, {json: {message: 'secrets/stripe.key.json: invalid document'}})
      const other = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(other.message).to.equal(
        'the server refused the write (HTTP 400): secrets/stripe.key.json: invalid document',
      )
      expect(other.message).to.not.include('does not accept secrets/')
    })
  })

  describe('carry-ins from the PR 2 validation (qfg-mol-hle PR 3)', () => {
    const createStripe = () =>
      secretCommitMessage({fingerprint: key.fingerprint, key: 'stripe.key', keyset: 'QUONFIG_KEYSET', verb: 'create'})

    it('S2: quonfig.json in a write must be a JSON object, even when the workspace has no secrets', async () => {
      stub(200, {json: {commitSha: 'c'.repeat(40)}})
      const repo = bareWorkspaceRepo(path.join(root, 'nosecrets'), {'quonfig.json': MANIFEST})
      const bare = await cloneWorkspaceSnapshot(pathToFileURL(repo.bare).href, {tmpRoot: root})
      try {
        for (const bad of ['{not json', '[]', '"x"', '', 'null', '42']) {
          const err = await refusalOf(
            pushWorkspaceFiles({
              files: [
                {afterJson: bad, path: 'quonfig.json'},
                {afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'},
              ],
              message: createStripe(),
              orgSlug: 'acme',
              snapshot: bare,
              workspaceId: WORKSPACE_ID,
            }),
          )
          expect(err.code, JSON.stringify(bad)).to.equal('invalid_input')
          expect(err.message, JSON.stringify(bad)).to.equal('quonfig.json must be a JSON object')
        }

        expect(calls).to.deep.equal([])
      } finally {
        await bare.cleanup()
      }
    })

    const LEAK = `Bearer qf_uk_SENTINEL_TOKEN https://u:SENTINELPAT@gitea.example/x.git qf1:QUONFIG_KEYSET:${key.fingerprint}:SENTINELCIPHER`

    it('S3: a 403 denial list is masked and capped like every other server text', async () => {
      stub(403, {
        json: {
          data: {
            denials: [
              {
                path: `secrets/stripe.key.json ${LEAK}`,
                reason: `protected ${LEAK} ${'x'.repeat(3000)}`,
                requiredPermission: `configs.write ${LEAK}`,
              },
            ],
          },
          message: 'forbidden',
        },
      })
      const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('denied')
      expect(err.message).to.not.match(/SENTINEL_TOKEN|SENTINELPAT|SENTINELCIPHER/)
      expect(err.message.length).to.be.lessThan(2000)
    })

    it('S3: a 400 message is masked and capped', async () => {
      stub(400, {json: {message: `bad ${LEAK} ${'y'.repeat(3000)}`}})
      const err = await refusalOf(write([{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}]))
      expect(err.code).to.equal('bad_request')
      expect(err.message).to.not.match(/SENTINEL_TOKEN|SENTINELPAT|SENTINELCIPHER/)
      expect(err.message.length).to.be.lessThan(700)
    })

    it('a SnapshotPathError from the snapshot becomes a SecretWriteError', async () => {
      stub(200, {json: {commitSha: 'c'.repeat(40)}})
      const hostile = {
        ...snap,
        readFile() {
          throw new SnapshotPathError('secrets/stripe.key.json', 'is not a regular file in the workspace repo')
        },
      } as WorkspaceSnapshot
      const err = await refusalOf(
        pushWorkspaceFiles({
          files: [{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}],
          message: createStripe(),
          orgSlug: 'acme',
          snapshot: hostile,
          workspaceId: WORKSPACE_ID,
        }),
      )
      expect(err.code).to.equal('invalid_input')
      expect(calls).to.deep.equal([])
    })

    it('secretCommitMessage reads each part once (an accessor cannot change it after validation)', () => {
      const reads: Record<string, number> = {}
      const once = (name: string, first: string) => ({
        get() {
          reads[name] = (reads[name] ?? 0) + 1
          return reads[name] === 1 ? first : 'evil\nPLAINTEXT hunter2'
        },
      })
      const parts = Object.defineProperties({} as never, {
        fingerprint: once('fingerprint', key.fingerprint),
        key: once('key', 'stripe.key'),
        keyset: once('keyset', 'QUONFIG_KEYSET'),
        scope: once('scope', 'production'),
        verb: once('verb', 'set'),
      })
      const message = secretCommitMessage(parts)
      expect(message.text).to.equal(`qfg: set secret stripe.key (production) on QUONFIG_KEYSET ${key.fingerprint}`)
      expect(
        Object.values(reads).every((n) => n === 1),
        JSON.stringify(reads),
      ).to.equal(true)
    })

    it('the issued message object is frozen', () => {
      const message = createStripe()
      expect(Object.isFrozen(message)).to.equal(true)
      expect(() => {
        ;(message as {text: string}).text = 'qfg: create secret stripe.key hunter2'
      }).to.throw(TypeError)
    })

    it("the message's key and verb must match a file this write changes", async () => {
      stub(200, {json: {commitSha: 'c'.repeat(40)}})
      for (const [files, message] of [
        [[{afterJson: secretDocText('other.key'), path: 'secrets/other.key.json'}], createStripe()],
        [
          [{afterJson: secretDocText('db.password'), path: 'secrets/db.password.json'}],
          secretCommitMessage({
            fingerprint: key.fingerprint,
            key: 'db.password',
            keyset: 'QUONFIG_KEYSET',
            verb: 'create',
          }),
        ],
        [
          [{delete: true, path: 'secrets/db.password.json'}],
          secretCommitMessage({
            fingerprint: key.fingerprint,
            key: 'db.password',
            keyset: 'QUONFIG_KEYSET',
            verb: 'set',
          }),
        ],
        [
          [{afterJson: secretDocText('stripe.key'), path: 'secrets/stripe.key.json'}],
          secretCommitMessage({key: 'stripe.key', verb: 'delete'}),
        ],
      ] as const) {
        const err = await refusalOf(
          pushWorkspaceFiles({files: [...files], message, orgSlug: 'acme', snapshot: snap, workspaceId: WORKSPACE_ID}),
        )
        expect(err.code, message.text).to.equal('invalid_input')
        expect(err.message, message.text).to.include('the commit message does not describe this write')
      }

      expect(calls).to.deep.equal([])
    })
  })
})
