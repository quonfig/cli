/**
 * callConfigsGitPush and the change-request fields (qfg-5bjew.17, T7).
 *
 * - `propose` goes on the wire only when the caller set it; a plain push's
 *   payload keeps exactly the keys it had before.
 * - A 200 carrying `changeRequest:{number,url,status}` is surfaced; one
 *   without a positive integer number is dropped (rule 2.12: the caller then
 *   treats a propose as unsupported).
 */

import {expect} from 'chai'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {callConfigsGitPush} from '../../src/push/config-push-client.js'

const INPUT = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  targetRef: 'refs/heads/cr-smoke',
  expectedSha: '0000000000000000000000000000000000000000',
  newSha: '0000000000000000000000000000000000000002',
  pack: Uint8Array.from([1, 2, 3]),
  hasUpstreamRemote: false,
}

describe('callConfigsGitPush change-request fields (qfg-5bjew.17)', () => {
  const originalFetch = globalThis.fetch
  const saved = {
    key: process.env.QUONFIG_API_KEY,
    api: process.env.QUONFIG_API_BASE_URL_OVERRIDE,
    domain: process.env.QUONFIG_DOMAIN,
  }
  let sentBody: {json: Record<string, unknown>} | undefined

  const stub = (status: number, body: unknown) => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      const text = JSON.stringify(body)
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      } as unknown as Response
    }) as typeof globalThis.fetch
  }

  beforeEach(() => {
    process.env.QUONFIG_API_KEY = 'qf_uk_fake_for_test'
    process.env.QUONFIG_API_BASE_URL_OVERRIDE = 'https://app.example.test'
    delete process.env.QUONFIG_DOMAIN
    sentBody = undefined
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const [k, v] of [
      ['QUONFIG_API_KEY', saved.key],
      ['QUONFIG_API_BASE_URL_OVERRIDE', saved.api],
      ['QUONFIG_DOMAIN', saved.domain],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('a plain push sends no propose key (payload keys unchanged)', async () => {
    stub(200, {json: {commitSha: INPUT.newSha, ref: INPUT.targetRef}})
    await callConfigsGitPush(INPUT, 'acme')
    expect(Object.keys(sentBody!.json).sort()).to.deep.equal(
      ['expectedSha', 'hasUpstreamRemote', 'newSha', 'pack', 'targetRef', 'workspaceId'].sort(),
    )
  })

  it('sends propose:{title,description} when set', async () => {
    stub(200, {
      json: {commitSha: INPUT.newSha, ref: INPUT.targetRef, changeRequest: {number: 3, url: '/w/x', status: 'open'}},
    })
    await callConfigsGitPush({...INPUT, propose: {title: 'T', description: 'D'}}, 'acme')
    expect(sentBody!.json.propose).to.deep.equal({title: 'T', description: 'D'})
  })

  it('surfaces changeRequest from a 200', async () => {
    stub(200, {
      json: {
        commitSha: INPUT.newSha,
        ref: INPUT.targetRef,
        changeRequest: {number: 3, url: '/workspaces/w/change-requests/3', status: 'open'},
      },
    })
    const res = await callConfigsGitPush({...INPUT, propose: {}}, 'acme')
    expect(res).to.deep.equal({
      kind: 'success',
      commitSha: INPUT.newSha,
      ref: INPUT.targetRef,
      changeRequest: {number: 3, url: '/workspaces/w/change-requests/3', status: 'open'},
    })
  })

  it('drops a changeRequest without a positive integer number', async () => {
    for (const changeRequest of [{url: '/x', status: 'open'}, {number: 0, url: '/x'}, {number: '3', url: '/x'}, null]) {
      stub(200, {json: {commitSha: INPUT.newSha, ref: INPUT.targetRef, changeRequest}})

      const res = await callConfigsGitPush({...INPUT, propose: {}}, 'acme')
      expect(res).to.deep.equal({kind: 'success', commitSha: INPUT.newSha, ref: INPUT.targetRef})
    }
  })
})
