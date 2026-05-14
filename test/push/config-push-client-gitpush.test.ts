/**
 * Tests for the `callConfigsGitPush` HTTP client (qfg-7429.4) — the
 * CLI side of the `configs.gitPush` oRPC procedure introduced in
 * qfg-7429.1. Mirrors the wire-shape mapping that `callConfigsPush`
 * already does for the file-delta endpoint.
 *
 * Coverage:
 *   - Encodes the binary pack as base64 in the JSON envelope and posts
 *     to `/api/v1/configs/gitPush`.
 *   - 200 → `{kind: 'success', commitSha, ref}`.
 *   - 409 → `{kind: 'conflict', message}` (server uses CONFLICT for
 *     `OriginMoved` — see git-push-handler.ts).
 *   - 403 with `data.denials` → `{kind: 'denied', denials,
 *     suggestedRecovery?}`.
 *   - 400 → `{kind: 'bad-request', message}`.
 */

import {expect} from 'chai'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {callConfigsGitPush} from '../../src/push/config-push-client.js'

const PACK = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])

const INPUT = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  targetRef: 'refs/heads/main',
  expectedSha: '0000000000000000000000000000000000000001',
  newSha: '0000000000000000000000000000000000000002',
  pack: PACK,
}

describe('callConfigsGitPush (qfg-7429.4)', () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.QUONFIG_API_KEY
  const originalApiOverride = process.env.QUONFIG_API_BASE_URL_OVERRIDE
  const originalDomain = process.env.QUONFIG_DOMAIN

  beforeEach(() => {
    process.env.QUONFIG_API_KEY = 'qf_uk_fake_for_test'
    process.env.QUONFIG_API_BASE_URL_OVERRIDE = 'https://app.example.test'
    delete process.env.QUONFIG_DOMAIN
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
    else process.env.QUONFIG_API_KEY = originalApiKey
    if (originalApiOverride === undefined) delete process.env.QUONFIG_API_BASE_URL_OVERRIDE
    else process.env.QUONFIG_API_BASE_URL_OVERRIDE = originalApiOverride
    if (originalDomain === undefined) delete process.env.QUONFIG_DOMAIN
    else process.env.QUONFIG_DOMAIN = originalDomain
  })

  let lastUrl: string | undefined
  let lastInit: RequestInit | undefined
  const stub = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      lastUrl = url
      lastInit = init
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
          return text
        },
        async json() {
          return JSON.parse(text) as unknown
        },
      } as unknown as Response
    }) as typeof globalThis.fetch
  }

  it('posts pack as base64 in {json: {...}} envelope to /api/v1/configs/gitPush and returns commitSha + ref on 200', async () => {
    stub(200, {json: {commitSha: INPUT.newSha, ref: 'refs/heads/main'}})

    const res = await callConfigsGitPush(INPUT, 'acme')

    expect(res).to.deep.equal({kind: 'success', commitSha: INPUT.newSha, ref: 'refs/heads/main'})

    expect(lastUrl).to.equal('https://app.example.test/api/v1/configs/gitPush')
    expect(lastInit?.method).to.equal('POST')

    const body = JSON.parse(lastInit?.body as string) as {json: {pack: string} & typeof INPUT}
    expect(body.json.workspaceId).to.equal(INPUT.workspaceId)
    expect(body.json.targetRef).to.equal('refs/heads/main')
    expect(body.json.expectedSha).to.equal(INPUT.expectedSha)
    expect(body.json.newSha).to.equal(INPUT.newSha)
    // Pack is base64-encoded so the JSON envelope stays text-safe.
    expect(body.json.pack).to.equal(Buffer.from(PACK).toString('base64'))
  })

  it('returns {kind: "conflict"} with the server message on 409 (OriginMoved)', async () => {
    stub(409, {
      json: {
        message: 'Origin refs/heads/main moved. Run `qfg pull --rebase` and retry.',
        data: {reason: 'OriginMoved'},
      },
    })

    const res = await callConfigsGitPush(INPUT, 'acme')
    expect(res.kind).to.equal('conflict')
    if (res.kind === 'conflict') {
      expect(res.message).to.match(/originmoved|moved|rebase/i)
    }
  })

  it('returns {kind: "denied", denials} on 403 with data.denials', async () => {
    stub(403, {
      json: {
        message: 'Push denied — 1 commit(s) failed per-file authorization',
        data: {
          denials: [
            {
              commitSha: 'deadbeefcafebabe0000000000000000abcdef00',
              path: 'configs/secret.json',
              reason: 'missing-permission',
              requiredPermission: 'config.edit.protected-all-envs',
            },
          ],
          suggestedRecovery: {
            kind: 'revert-upstream',
            offendingCommitSha: 'deadbeefcafebabe0000000000000000abcdef00',
            message: 'Revert it upstream and try again.',
          },
        },
      },
    })

    const res = await callConfigsGitPush(INPUT, 'acme')
    expect(res.kind).to.equal('denied')
    if (res.kind === 'denied') {
      expect(res.denials).to.have.length(1)
      expect(res.denials[0].commitSha).to.equal('deadbeefcafebabe0000000000000000abcdef00')
      expect(res.denials[0].requiredPermission).to.equal('config.edit.protected-all-envs')
    }
  })

  it('returns {kind: "bad-request"} on 400', async () => {
    stub(400, {json: {message: 'Pack rejected by git index-pack --strict: bad object'}})

    const res = await callConfigsGitPush(INPUT, 'acme')
    expect(res.kind).to.equal('bad-request')
    if (res.kind === 'bad-request') {
      expect(res.message).to.match(/index-pack|bad object/i)
    }
  })
})
