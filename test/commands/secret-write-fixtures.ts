/**
 * A fake Quonfig server for the secret write commands (qfg-mol-hle PR 3):
 * the workspace's git repo is a real file:// bare repo, handed out by a faked
 * `gitea/token`; `configs/push` is captured (the real server does not accept
 * secrets/ yet, app-quonfig qfg-mol-bkt). Every request is recorded so tests
 * can check that plaintext never reaches one and that no old route is used.
 * Keys are minted at run time; no key literal is committed.
 */
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {PassThrough, Readable} from 'node:stream'
import {pathToFileURL} from 'node:url'

import {encrypt} from '../../src/secrets/qf1.js'
import {
  newSecretDocument,
  secretValue,
  serializeSecretDocument,
  setSecretScopeValue,
} from '../../src/secrets/secret-doc.js'
import {bareWorkspaceRepo, quonfigJson, testKey, tmpDir} from '../secrets/plumbing-fixtures.js'
import {getApiBase} from '../test-domain-helper.js'

/** A second workspace of the test org, for --workspace tests. */
export const WORKSPACE_B = '00000000-0000-4000-8000-00000000000b'

export const keys = {main: testKey(), prod: testKey(), second: testKey()}

/** Two keysets; QUONFIG_KEYSET has two public keys, so a write must use the FIRST. */
export const TWO_KEYSETS = quonfigJson(
  {
    QUONFIG_KEYSET: {publicKeys: [keys.main.publicEntry, keys.second.publicEntry]},
    QUONFIG_KEYSET_PROD: {publicKeys: [keys.prod.publicEntry]},
  },
  ['production', 'staging'],
)

export const ONE_KEYSET = quonfigJson(
  {QUONFIG_KEYSET: {publicKeys: [keys.main.publicEntry, keys.second.publicEntry]}},
  ['production', 'staging'],
)

export type Recorded = {body: any; url: string}

export type FakeServerState = {
  /** environments.getDefaultCreateAccess: a status to fail with, or the tier (null = unset). */
  access: null | number | string
  /** metadata/getByKey documents, by key. */
  documents: Record<string, unknown>
  /** metadata/list entries. */
  listed: Array<{key: string; type: string; valueType: string}>
  /** configs.push reply: status and body. */
  push: {body: unknown; status: number}
  requests: Recorded[]
  repoUrl: string
  /** gitea/token: a status to fail with, else a token for repoUrl. */
  tokenStatus?: number
}

export const state: FakeServerState = {
  access: null,
  documents: {},
  listed: [],
  push: {body: {json: {commitSha: 'c'.repeat(40)}}, status: 200},
  repoUrl: '',
  requests: [],
}

let root: string | undefined

/** Make `files` the workspace's main branch for the next command. */
export function workspace(files: Record<string, string>): void {
  root ??= tmpDir('qfg-secret-cmd-')
  const repo = bareWorkspaceRepo(fs.mkdtempSync(path.join(root, 'ws-')), files)
  state.repoUrl = pathToFileURL(repo.bare).href
}

export function resetState(): void {
  state.access = null
  state.documents = {}
  state.listed = []
  state.push = {body: {json: {commitSha: 'c'.repeat(40)}}, status: 200}
  state.requests = []
  state.tokenStatus = undefined
}

export function removeWorkspaces(): void {
  if (root) fs.rmSync(root, {force: true, maxRetries: 3, recursive: true})
  root = undefined
}

/** The bodies sent to configs/push. */
export const pushes = () => state.requests.filter((r) => r.url.endsWith('/api/v1/configs/push')).map((r) => r.body.json)

/** Requests to the per-family write routes a secret must never use. */
export const legacyWrites = () =>
  state.requests.filter((r) => /\/api\/v1\/(configs\/(create|update)|flags\/update|logLevels\/update)$/.test(r.url))

const api = getApiBase()
const record = async (request: Request) => {
  const text = await request.text()
  state.requests.push({body: text ? JSON.parse(text) : undefined, url: request.url})
}

export const server = setupServer(
  http.post(`${api}/api/v1/gitea/token`, async ({request}) => {
    await record(request)
    if (state.tokenStatus) return HttpResponse.json({json: {message: 'no token for you'}}, {status: state.tokenStatus})
    // Already expired, so every command mints again and never reuses an
    // earlier test's repo URL from the token store.
    return HttpResponse.json({
      json: {
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        repoUrl: state.repoUrl,
        token: 'fake-read-token',
        workspaceId: 'workspace-123',
        workspaceSlug: 'test-workspace',
      },
    })
  }),
  http.post(`${api}/api/v1/configs/push`, async ({request}) => {
    await record(request)
    return HttpResponse.json(state.push.body as never, {status: state.push.status})
  }),
  http.post(`${api}/api/v1/environments/getDefaultCreateAccess`, async ({request}) => {
    await record(request)
    if (typeof state.access === 'number') return HttpResponse.json({json: {message: 'nope'}}, {status: state.access})
    return HttpResponse.json({json: {defaultCreateAccess: state.access}})
  }),
  http.post(`${api}/api/v1/environments/list`, async ({request}) => {
    await record(request)
    return HttpResponse.json({
      json: [
        {active: true, id: '6', name: 'staging', protected: false},
        {active: true, id: '7', name: 'production', protected: true},
      ],
    })
  }),
  http.post(`${api}/api/v1/metadata/list`, async ({request}) => {
    await record(request)
    return HttpResponse.json({json: {configs: state.listed}})
  }),
  http.post(`${api}/api/v1/metadata/getByKey`, async ({request}) => {
    await record(request)
    const doc = state.documents[state.requests.at(-1)?.body?.json?.key as string]
    return doc ? HttpResponse.json({json: doc}) : HttpResponse.json({json: {message: 'not found'}}, {status: 404})
  }),
  // `--workspace test-organization/ws-b` resolves here (OAuth org-scoped path).
  http.post(`${api}/api/v1/userWorkspaces/list`, async ({request}) => {
    await record(request)
    return HttpResponse.json({
      json: [
        {
          organizationName: 'Test Organization',
          workosOrgId: 'org_workspace-123',
          workspaceId: 'workspace-123',
          workspaceSlug: 'test-workspace',
        },
        {
          organizationName: 'Test Organization',
          workosOrgId: 'org_workspace-123',
          workspaceId: WORKSPACE_B,
          workspaceSlug: 'ws-b',
        },
      ],
    })
  }),
  http.post(`${api}/api/v1/:family/:action`, async ({request}) => {
    await record(request)
    return HttpResponse.json({json: {message: 'route not faked in secret tests'}}, {status: 500})
  }),
)

// --value-stdin: swap process.stdin for a Readable (as create.test.ts does).
let savedStdin: PropertyDescriptor | undefined
export const setStdin = (text: string): void => {
  savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', {configurable: true, value: Readable.from([text])})
}

export const restoreStdin = (): void => {
  if (savedStdin) Object.defineProperty(process, 'stdin', savedStdin)
  savedStdin = undefined
}

/** A stored secret: default on QUONFIG_KEYSET; Production has a targeting rule and a fallback on QUONFIG_KEYSET_PROD. */
export function storedSecret(key: string, options: {defaultTargeting?: boolean} = {}): string {
  const on = (keyset: string, recipient: string) =>
    secretValue(encrypt({keyset, plaintext: 'FAKE_OLD_STORED_VALUE_0001', recipient}))
  const doc = setSecretScopeValue(newSecretDocument(key), {value: on('QUONFIG_KEYSET', keys.main.publicEntry)}).document
  if (options.defaultTargeting) {
    doc.default.rules.unshift({
      criteria: [
        {operator: 'PROP_IS_ONE_OF', propertyName: 'user.key', valueToMatch: {type: 'string_list', value: ['u2']}},
      ],
      value: on('QUONFIG_KEYSET', keys.main.publicEntry),
    })
  }

  doc.environments = [
    {
      id: 'production',
      rules: [
        {
          criteria: [
            {operator: 'PROP_IS_ONE_OF', propertyName: 'user.key', valueToMatch: {type: 'string_list', value: ['u1']}},
          ],
          value: on('QUONFIG_KEYSET_PROD', keys.prod.publicEntry),
        },
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: on('QUONFIG_KEYSET_PROD', keys.prod.publicEntry)},
      ],
    },
  ]
  return serializeSecretDocument(doc)
}

/** A configs/ document holding an old-format (decryptWith) value. */
export function oldFormatConfig(key: string): Record<string, unknown> {
  return {
    access: 'standard',
    commitSha: 'a'.repeat(40),
    default: {
      rules: [
        {
          criteria: [{operator: 'ALWAYS_TRUE'}],
          value: {
            confidential: true,
            decryptWith: 'quonfig.secrets.encryption.key',
            type: 'string',
            value: 'aaaa--bbbbbbbbbbbbbbbbbbbbbbbb--cccccccccccccccccccccccccccccccc',
          },
        },
      ],
    },
    environments: [],
    key,
    sendToClientSdk: false,
    tags: [],
    type: 'config',
    valueType: 'string',
    variants: [],
  }
}

/** Every recorded request, as text, for leak checks. */
export const allRequestText = (): string => JSON.stringify(state.requests)

/** Feed raw bytes to --value-stdin. */
export const setStdinBytes = (bytes: Buffer): void => {
  savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', {configurable: true, value: Readable.from([bytes])})
}

let savedStdoutTty: PropertyDescriptor | undefined
/**
 * Make the command think it runs on a terminal, and type `keys` into it after
 * a short delay: what an interactive prompt prints lands in the captured
 * stdout. Pair with restoreTty.
 */
export const fakeTty = (keys: string, delayMs = 300): void => {
  savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  const input = new PassThrough() as {isTTY?: boolean; setRawMode?: () => void} & PassThrough
  input.isTTY = true
  input.setRawMode = () => {}
  Object.defineProperty(process, 'stdin', {configurable: true, value: input})
  // A redirected stdout (a file, CI) has a read-only isTTY: define it instead.
  savedStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: true, writable: true})
  if (keys) setTimeout(() => input.write(keys), delayMs)
}

export const restoreTty = (): void => {
  restoreStdin()
  if (savedStdoutTty) Object.defineProperty(process.stdout, 'isTTY', savedStdoutTty)
  else delete (process.stdout as {isTTY?: boolean}).isTTY
}

/** Prompt text with terminal wrapping and escapes removed, for matching. */
export const flat = (text: string): string =>
  text.replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[\\d;?]*[A-Za-z]`, 'g'), '').replaceAll(/\s+/g, ' ')
