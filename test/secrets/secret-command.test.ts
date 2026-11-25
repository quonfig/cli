/**
 * The command-side helpers of a secret write (src/secrets/secret-command.ts),
 * against a stub command: the default-tier lookup, the target-workspace
 * guard, the push, the readability note and the failure texts. Bead
 * qfg-mol-hle PR 3a (fix round, D3/D4).
 */
import {expect} from 'chai'

import type {APICommand} from '../../src/index.js'

import {KeysetChoiceError} from '../../src/secrets/choose-keyset.js'
import {
  SecretCommandError,
  defaultCreateAccess,
  knownSecretFailure,
  openCommandSnapshot,
  pushPlan,
  readabilityNote,
  writeErrorMessage,
} from '../../src/secrets/secret-command.js'
import {SecretRefusal, type SecretWritePlan} from '../../src/secrets/secret-write-flow.js'
import {SnapshotPathError, type SnapshotDeps, type WorkspaceSnapshot} from '../../src/secrets/workspace-snapshot.js'
import {SecretWriteError} from '../../src/secrets/write-secret.js'
import {testKey} from './plumbing-fixtures.js'

const WS = '00000000-0000-4000-8000-000000000001'

type Reply = {error?: unknown; json?: unknown; ok: boolean; status: number}

function stubCommand(reply: (() => Promise<Reply>) | Reply, workspaceId: string | undefined = WS) {
  const posts: Array<[string, unknown]> = []
  const command = {
    apiClient: {
      async post(path: string, payload: unknown) {
        posts.push([path, payload])
        return typeof reply === 'function' ? reply() : reply
      },
    },
    workspaceId,
  } as unknown as APICommand
  return {command, posts}
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (error) {
    return error as Error
  }

  return expect.fail('expected a failure')
}

describe('secret-command helpers (qfg-mol-hle PR 3a)', () => {
  describe('defaultCreateAccess', () => {
    it('asks environments.getDefaultCreateAccess for the target workspace', async () => {
      const {command, posts} = stubCommand({json: {defaultCreateAccess: 'protected-env'}, ok: true, status: 200})
      expect(await defaultCreateAccess(command)).to.equal('protected-env')
      expect(posts).to.deep.equal([['/api/v1/environments/getDefaultCreateAccess', {workspaceId: WS}]])
    })

    it('only an explicit null means unset, which is standard', async () => {
      const {command} = stubCommand({json: {defaultCreateAccess: null}, ok: true, status: 200})
      expect(await defaultCreateAccess(command)).to.equal('standard')
    })

    for (const [label, reply] of [
      ['an HTTP error', {ok: false, status: 503}],
      ['a body without the member', {json: {}, ok: true, status: 200}],
      ['no body', {json: null, ok: true, status: 200}],
      ['a body that is not an object', {json: 'standard', ok: true, status: 200}],
    ] as const) {
      it(`fails on ${label}, saying nothing was written`, async () => {
        const err = await failure(defaultCreateAccess(stubCommand(reply as Reply).command))
        expect(err).to.be.instanceOf(SecretCommandError)
        expect(err.message).to.match(
          /^could not read the workspace's default access tier for new items \(.+\); nothing was written$/,
        )
      })
    }

    it('fails clearly when the request itself fails (dropped connection, non-JSON body)', async () => {
      const err = await failure(
        defaultCreateAccess(
          stubCommand(async () => {
            throw new SyntaxError("Unexpected token '<'")
          }).command,
        ),
      )
      expect(err.message).to.equal(
        "could not read the workspace's default access tier for new items (the request failed); nothing was written",
      )
    })

    it('refuses a tier this qfg does not know', async () => {
      for (const tier of ['end-user', '', 7]) {
        const err = await failure(
          defaultCreateAccess(stubCommand({json: {defaultCreateAccess: tier}, ok: true, status: 200}).command),
        )
        expect(err.message).to.match(/does not know/)
      }
    })

    it('refuses without a target workspace, before any request', async () => {
      const {command, posts} = stubCommand({json: {defaultCreateAccess: null}, ok: true, status: 200}, '')
      const err = await failure(defaultCreateAccess(command))
      expect(err).to.be.instanceOf(SecretCommandError)
      expect(posts).to.deep.equal([])
    })
  })

  describe('openCommandSnapshot', () => {
    const snapshotOf = () => {
      let cleaned = 0
      const snapshot = {
        async cleanup() {
          cleaned++
        },
      } as unknown as WorkspaceSnapshot
      return {cleaned: () => cleaned, snapshot}
    }

    const deps = (workspaceId: string, snapshot: WorkspaceSnapshot): SnapshotDeps => ({
      clone: async () => snapshot,
      loadToken: async () => ({expiresAt: null, repoUrl: 'file:///x', token: 't'}),
      mintToken: async () => expect.fail('must not mint'),
      resolveWorkspace: async () => ({orgSlug: 'acme', workspaceId}),
    })

    it('returns the snapshot of the target workspace', async () => {
      const s = snapshotOf()
      const r = await openCommandSnapshot(stubCommand({ok: true, status: 200}).command, undefined, deps(WS, s.snapshot))
      expect(r).to.deep.equal({orgSlug: 'acme', snapshot: s.snapshot, workspaceId: WS})
    })

    it('refuses, and removes, a snapshot of another workspace', async () => {
      const s = snapshotOf()
      const err = await failure(
        openCommandSnapshot(stubCommand({ok: true, status: 200}).command, 'acme/other', deps('other-ws', s.snapshot)),
      )
      expect(err).to.be.instanceOf(SecretCommandError)
      expect(s.cleaned()).to.equal(1)
    })

    it('refuses when the command has no target workspace (the guard is never skipped)', async () => {
      const s = snapshotOf()
      const err = await failure(
        openCommandSnapshot(stubCommand({ok: true, status: 200}, '').command, undefined, deps('', s.snapshot)),
      )
      expect(err).to.be.instanceOf(SecretCommandError)
    })
  })

  it('pushPlan sends workspaceId and orgSlug in their own fields, with the plan message', async () => {
    const originalFetch = globalThis.fetch
    const savedKey = process.env.QUONFIG_API_KEY
    const savedBase = process.env.QUONFIG_API_BASE_URL_OVERRIDE
    process.env.QUONFIG_API_KEY = 'qf_uk_fake_for_test'
    process.env.QUONFIG_API_BASE_URL_OVERRIDE = 'https://app.example.test'
    let body: any
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return {ok: true, status: 200, text: async () => JSON.stringify({json: {commitSha: 'c'.repeat(40)}})}
    }) as never
    try {
      // A plan whose file is refused before the request still proves the field
      // routing through the error path; use a minimal valid one instead.
      const {planSecretCreate} = await import('../../src/secrets/secret-write-flow.js')
      const {cloneWorkspaceSnapshot} = await import('../../src/secrets/workspace-snapshot.js')
      const {bareWorkspaceRepo, quonfigJson, tmpDir} = await import('./plumbing-fixtures.js')
      const {pathToFileURL} = await import('node:url')
      const fs = await import('node:fs')
      const k = testKey()
      const root = tmpDir('qfg-pushplan-')
      try {
        const repo = bareWorkspaceRepo(root, {
          'quonfig.json': quonfigJson({QUONFIG_KEYSET: {publicKeys: [k.publicEntry]}}),
        })
        const snapshot = await cloneWorkspaceSnapshot(pathToFileURL(repo.bare).href, {tmpRoot: root})
        try {
          const plan: SecretWritePlan = await planSecretCreate({
            access: 'standard',
            interactive: false,
            key: 'a.b',
            plaintext: 'x',
            snapshot,
          })
          expect(await pushPlan(plan, {orgSlug: 'acme', snapshot, workspaceId: WS})).to.equal('c'.repeat(40))
          expect(body.json.workspaceId).to.equal(WS)
          expect(body.json.message).to.equal(plan.message.text)
        } finally {
          await snapshot.cleanup()
        }
      } finally {
        fs.rmSync(root, {force: true, recursive: true})
      }
    } finally {
      globalThis.fetch = originalFetch
      if (savedKey === undefined) delete process.env.QUONFIG_API_KEY
      else process.env.QUONFIG_API_KEY = savedKey
      if (savedBase === undefined) delete process.env.QUONFIG_API_BASE_URL_OVERRIDE
      else process.env.QUONFIG_API_BASE_URL_OVERRIDE = savedBase
    }
  }).timeout(30_000)

  describe('readabilityNote', () => {
    const k = testKey()
    const choice = {
      fingerprint: k.fingerprint,
      keyset: 'QUONFIG_KEYSET',
      recipient: k.publicEntry,
      source: 'only',
    } as const

    it('says nothing when this machine holds the write key', () => {
      expect(readabilityNote(choice, {QUONFIG_KEYSET: k.privateEntry})).to.equal(undefined)
    })

    it('says this machine cannot read the keyset when it is absent, and that this is expected', () => {
      expect(readabilityNote(choice, {})).to.equal(
        'This machine cannot read QUONFIG_KEYSET values (no QUONFIG_KEYSET here). That is expected: writing needs no private key.',
      )
    })

    it('calls a malformed keyset env var malformed (by position, never its content), not "expected"', () => {
      const note = readabilityNote(choice, {QUONFIG_KEYSET: 'not-a-key-SENTINEL'})!
      expect(note).to.equal(
        'QUONFIG_KEYSET on this machine is malformed (entry 1), so this machine cannot read this value; fix or remove it (writing needs no private key).',
      )
      expect(note).to.not.include('SENTINEL')
    })
  })

  describe('failure texts', () => {
    it('knownSecretFailure maps every known failure, including refusals and snapshot path errors, and nothing else', () => {
      expect(knownSecretFailure(new SecretRefusal('exists', 'k already exists (as a secret)'))).to.equal(
        'k already exists (as a secret)',
      )
      expect(knownSecretFailure(new KeysetChoiceError('ambiguous', 'Choose a keyset'))).to.equal('Choose a keyset')
      expect(knownSecretFailure(new SnapshotPathError('x', 'is outside the workspace snapshot'))).to.equal(
        '"x" is outside the workspace snapshot',
      )
      expect(knownSecretFailure(new TypeError('boom'))).to.equal(undefined)
    })

    it('a denial naming the path is a permission problem; a 403 without denials is not', () => {
      const denials = [{path: 'secrets/a.json', reason: 'tier', requiredPermission: 'p'}]
      expect(
        writeErrorMessage(new SecretWriteError('denied', 'the server refused the write: x', denials as never)),
      ).to.equal(
        'you do not have permission to write this secret; nothing was written. the server refused the write: x',
      )
      expect(
        writeErrorMessage(new SecretWriteError('denied', 'the server refused the request (HTTP 403): y', [])),
      ).to.equal('the server refused the request (HTTP 403): y')
    })

    it('only the allow-list refusal gets the "does not support secrets/ yet" text', () => {
      expect(
        writeErrorMessage(new SecretWriteError('bad_request', 'this Quonfig server does not accept secrets/ yet (x)')),
      ).to.match(/^this Quonfig server does not support secrets\/ yet, so nothing was written\./)
      expect(
        writeErrorMessage(new SecretWriteError('bad_request', 'the server refused the write (HTTP 400): y')),
      ).to.equal('the server refused the write (HTTP 400): y')
    })
  })
})
