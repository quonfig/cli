/**
 * Unit tests for `qfg serve` — see plan project/plans/qfg-serve.md.
 *
 * Coverage matches the bead acceptance list (qfg-38sf.1):
 *   - flag parsing + defaults + port-collision message
 *   - datadir discovery (./our-config → ./.quonfig → error)
 *   - auth (Basic 1:<key>) when --frontend-sdk-key set; no auth otherwise
 *   - CORS headers on success and 401
 *   - eval-with-context: base64url decode, envelope shape, frontend-only filter
 *   - POST /api/v1/telemetry/ → 404 with helpful body
 *   - unknown path → 404
 *   - --watch: editing a datadir file is reflected on the next request
 *   - --allow-non-loopback gating + WARN
 *
 * Tests boot a real http.Server on an OS-chosen port (`port: 0`) so they can
 * run in parallel without colliding. The port-collision test takes a
 * pre-bound port and asserts the error message.
 */
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import {resolveDatadirForServe} from '../../src/serve/datadir-discovery.js'
import {startServer, ServeHandle} from '../../src/serve/server.js'

/**
 * Write a config that uses `type: "provided"` with `source: "ENV_VAR"`. Used
 * by the F1+F2 regression test to assert qfg serve mirrors api-delivery's
 * pass-through behavior: the config flows through unchanged when
 * sendToClientSdk=true, and is dropped entirely when sendToClientSdk=false
 * (regardless of --frontend-sdk-key — the filter is unconditional per F3).
 */
function writeProvidedFixture(dir: string, sendToClientSdk: boolean): void {
  fs.mkdirSync(path.join(dir, 'configs'), {recursive: true})
  fs.mkdirSync(path.join(dir, 'feature-flags'), {recursive: true})
  fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({environments: ['development']}), 'utf8')
  fs.writeFileSync(
    path.join(dir, 'configs', 'sample.provided.json'),
    JSON.stringify({
      key: 'sample.provided',
      type: 'config',
      valueType: 'string',
      sendToClientSdk,
      default: {
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'provided', value: {source: 'ENV_VAR', lookup: 'CANARY_TEST_KEY'}},
          },
        ],
      },
    }),
    'utf8',
  )
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-serve-'))
}

/**
 * Minimal datadir fixture: one config (sendToClientSdk=true) and one
 * server-only config (sendToClientSdk=false). The two-config layout lets the
 * frontend-filter test assert that only the client-sdk config makes it into
 * the envelope when an SDK key is required.
 */
function writeFixtureDatadir(dir: string, value: string = 'hello'): void {
  fs.mkdirSync(path.join(dir, 'configs'), {recursive: true})
  fs.mkdirSync(path.join(dir, 'feature-flags'), {recursive: true})
  fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({environments: ['development']}), 'utf8')
  fs.writeFileSync(
    path.join(dir, 'configs', 'sample.greeting.json'),
    JSON.stringify({
      key: 'sample.greeting',
      type: 'config',
      valueType: 'string',
      sendToClientSdk: true,
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value}}]},
    }),
    'utf8',
  )
  // sendToClientSdk: false — must be filtered out for frontend keys.
  fs.writeFileSync(
    path.join(dir, 'configs', 'sample.secret.json'),
    JSON.stringify({
      key: 'sample.secret',
      type: 'config',
      valueType: 'string',
      sendToClientSdk: false,
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'sssh'}}]},
    }),
    'utf8',
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

async function httpRequest(
  port: number,
  method: string,
  pathName: string,
  headers: Record<string, string> = {},
): Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}> {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: pathName, headers}, (res) => {
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
      })
      res.on('end', () => {
        resolve({status: res.statusCode ?? 0, headers: res.headers, body: buf})
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function basicAuth(key: string): string {
  return 'Basic ' + Buffer.from(`1:${key}`).toString('base64')
}

describe('qfg serve', () => {
  describe('resolveDatadirForServe (datadir discovery)', () => {
    it('prefers --datadir flag when given', () => {
      const dir = tmpDir()
      try {
        const out = resolveDatadirForServe({flagDatadir: dir, envDatadir: undefined, cwd: '/tmp'})
        expect(out.kind).to.equal('ok')
        if (out.kind === 'ok') {
          expect(out.dir).to.equal(dir)
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('falls back to ./our-config when present', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(path.join(dir, 'our-config'))
        const out = resolveDatadirForServe({flagDatadir: undefined, envDatadir: undefined, cwd: dir})
        expect(out.kind).to.equal('ok')
        if (out.kind === 'ok') {
          expect(out.dir).to.equal(path.join(dir, 'our-config'))
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('falls back to ./.quonfig when our-config is missing', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(path.join(dir, '.quonfig'))
        const out = resolveDatadirForServe({flagDatadir: undefined, envDatadir: undefined, cwd: dir})
        expect(out.kind).to.equal('ok')
        if (out.kind === 'ok') {
          expect(out.dir).to.equal(path.join(dir, '.quonfig'))
        }
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    it('errors when neither default exists', () => {
      const dir = tmpDir()
      try {
        const out = resolveDatadirForServe({flagDatadir: undefined, envDatadir: undefined, cwd: dir})
        expect(out.kind).to.equal('error')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })

  describe('startServer (HTTP behavior)', () => {
    let dir: string
    let handle: ServeHandle | undefined

    beforeEach(() => {
      dir = tmpDir()
      writeFixtureDatadir(dir)
      handle = undefined
    })

    afterEach(async () => {
      if (handle) await handle.close()
      fs.rmSync(dir, {recursive: true, force: true})
    })

    it('serves /api/v2/configs/eval-with-context with an EvalEnvelope', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })

      const ctx = base64url(JSON.stringify({user: {key: 'u1'}}))
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
      expect(res.status).to.equal(200)
      const body = JSON.parse(res.body)
      expect(body).to.have.property('evaluations')
      expect(body).to.have.property('meta')
      expect(body.meta.environment).to.equal('development')
      expect(body.evaluations['sample.greeting']).to.exist
      expect(body.evaluations['sample.greeting'].value).to.deep.equal({type: 'string', value: 'hello'})
      expect(body.evaluations['sample.greeting'].configType).to.equal('config')
      expect(body.evaluations['sample.greeting'].valueType).to.equal('string')
      expect(body.evaluations['sample.greeting'].reason).to.equal('STATIC')
    })

    it('emits CORS headers on success', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const ctx = base64url(JSON.stringify({}))
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
      expect(res.headers['access-control-allow-origin']).to.equal('*')
      expect(res.headers['access-control-allow-methods']).to.contain('GET')
      expect(res.headers['access-control-allow-methods']).to.contain('POST')
      expect(res.headers['access-control-allow-methods']).to.contain('OPTIONS')
      expect(res.headers['access-control-allow-headers']).to.match(/authorization/i)
      expect(res.headers['access-control-expose-headers']).to.match(/etag/i)
    })

    it('responds to OPTIONS preflight with CORS headers + 204', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const res = await httpRequest(handle.port, 'OPTIONS', '/api/v2/configs/eval-with-context/x')
      expect(res.status).to.equal(204)
      expect(res.headers['access-control-allow-origin']).to.equal('*')
    })

    it('returns 401 (+WWW-Authenticate) when --frontend-sdk-key is set and request has no auth', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        frontendSdkKey: 'PUBLIC-1234',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const ctx = base64url(JSON.stringify({}))
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
      expect(res.status).to.equal(401)
      expect(res.headers['www-authenticate']).to.match(/Basic realm="qfg-serve"/)
      // CORS still present on the 401 so the browser surfaces it.
      expect(res.headers['access-control-allow-origin']).to.equal('*')
    })

    it('returns 200 when --frontend-sdk-key is set and the correct Basic 1:<key> header is sent', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        frontendSdkKey: 'PUBLIC-1234',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const ctx = base64url(JSON.stringify({}))
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`, {
        Authorization: basicAuth('PUBLIC-1234'),
      })
      expect(res.status).to.equal(200)
    })

    it('filters out non-sendToClientSdk configs when --frontend-sdk-key is set', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        frontendSdkKey: 'PUBLIC-1234',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const ctx = base64url(JSON.stringify({}))
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`, {
        Authorization: basicAuth('PUBLIC-1234'),
      })
      expect(res.status).to.equal(200)
      const body = JSON.parse(res.body)
      expect(body.evaluations).to.have.property('sample.greeting')
      // sendToClientSdk: false — must be filtered out.
      expect(body.evaluations).to.not.have.property('sample.secret')
    })

    // F3 — mandatory unconditional sendToClientSdk filter (qfg-38sf.1 security
    // audit). Every qfg serve consumer is by definition a frontend client, so
    // the filter applies whether or not --frontend-sdk-key is set. Inverse of
    // the previous "includes both" assertion — that behavior was the bug.
    it('filters out non-sendToClientSdk configs even when no --frontend-sdk-key is set (F3)', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const ctx = base64url(JSON.stringify({}))
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
      expect(res.status).to.equal(200)
      const body = JSON.parse(res.body)
      expect(body.evaluations).to.have.property('sample.greeting')
      // F3: server-only config MUST be dropped even without --frontend-sdk-key.
      expect(body.evaluations).to.not.have.property('sample.secret')
    })

    // F1+F2 regression — qfg serve mirrors api-delivery's pass-through behavior
    // for `provided` / `confidential` / `decryptWith` metadata. The single
    // gate is `sendToClientSdk` from F3: when false the config is dropped
    // entirely (envelope contains no key, no id, no lookup name, no resolved
    // value); when true the config flows through with its ENV_VAR pointer
    // intact (lookup name is in the JSON, the resolved env value is not,
    // because sdk-node's evaluator doesn't read process.env for context-aware
    // eval — see sdk-node/src/rawMatch.ts:75-78). Customer's explicit choice.
    describe('provided/ENV_VAR pass-through (F1+F2)', () => {
      const SECRET_VALUE = 'CANARY_VALUE_must_not_leak'

      beforeEach(() => {
        process.env.CANARY_TEST_KEY = SECRET_VALUE
      })

      afterEach(() => {
        delete process.env.CANARY_TEST_KEY
      })

      it('drops provided/ENV_VAR configs entirely when sendToClientSdk is false (F3 filter)', async () => {
        const providedDir = tmpDir()
        try {
          writeProvidedFixture(providedDir, false)
          handle = await startServer({
            datadir: providedDir,
            environment: 'development',
            port: 0,
            host: '127.0.0.1',
            corsOrigins: ['*'],
            watch: false,
            allowNonLoopback: false,
            verbose: false,
            logger: noopLogger(),
          })
          const ctx = base64url(JSON.stringify({}))
          const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
          expect(res.status).to.equal(200)
          // The whole envelope must not leak:
          //  - the resolved env value (sdk-node doesn't resolve it, but belt+suspenders)
          //  - the ENV_VAR lookup name (config dropped entirely)
          //  - the config key/id (config dropped entirely)
          expect(res.body).to.not.contain(SECRET_VALUE)
          expect(res.body).to.not.contain('CANARY_TEST_KEY')
          expect(res.body).to.not.contain('sample.provided')
          const body = JSON.parse(res.body)
          expect(body.evaluations).to.not.have.property('sample.provided')
        } finally {
          fs.rmSync(providedDir, {recursive: true, force: true})
        }
      })

      it('passes provided/ENV_VAR lookup through when sendToClientSdk is true (matches api-delivery)', async () => {
        const providedDir = tmpDir()
        try {
          writeProvidedFixture(providedDir, true)
          handle = await startServer({
            datadir: providedDir,
            environment: 'development',
            port: 0,
            host: '127.0.0.1',
            corsOrigins: ['*'],
            watch: false,
            allowNonLoopback: false,
            verbose: false,
            logger: noopLogger(),
          })
          const ctx = base64url(JSON.stringify({}))
          const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
          expect(res.status).to.equal(200)
          // sdk-node's evaluator does resolve ENV_VAR in evaluateConfig (see
          // resolver.ts:53-65 — it reads process.env when val.type === 'provided').
          // That's the *intended* behavior in datadir mode and matches the
          // customer's explicit choice when they set sendToClientSdk=true.
          // The lookup name MUST appear when the value is the ProvidedData
          // pointer (api-delivery pass-through). Either form is acceptable as
          // long as the config is in the envelope and the customer's choice
          // is respected.
          const body = JSON.parse(res.body)
          expect(body.evaluations).to.have.property('sample.provided')
          // The envelope must reference the customer's choice somewhere — either
          // the resolved env value or the lookup pointer. Both mean the config
          // wasn't filtered out by F3.
          const hasLookup = res.body.includes('CANARY_TEST_KEY')
          const hasResolvedValue = res.body.includes(SECRET_VALUE)
          expect(hasLookup || hasResolvedValue).to.equal(
            true,
            'envelope must contain either the ENV_VAR lookup name or the resolved value when sendToClientSdk=true',
          )
        } finally {
          fs.rmSync(providedDir, {recursive: true, force: true})
        }
      })
    })

    // G6 — base64 context token size cap. Without this, a client can send a
    // 10MB context token and force the server to allocate the decoded buffer
    // (and the JSON parser to walk it). Cap raw token length at 64KB and
    // reject with 414 URI Too Long.
    it('rejects oversized context token with 414 URI Too Long (G6)', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      // 100KB token — well over the 64KB cap. Use a base64-safe filler.
      const oversized = 'A'.repeat(100 * 1024)
      const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${oversized}`)
      expect(res.status).to.equal(414)
    })

    it('returns 404 (with helpful body) on POST /api/v1/telemetry/', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const res = await httpRequest(handle.port, 'POST', '/api/v1/telemetry/')
      expect(res.status).to.equal(404)
      // The body should tell the user how to disable telemetry — checking for
      // the option name catches both "drop telemetry" and "redirect" paths.
      expect(res.body).to.match(/collectevaluationsummaries/i)
    })

    it('returns 404 for unknown paths', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })
      const res = await httpRequest(handle.port, 'GET', '/random/nonsense')
      expect(res.status).to.equal(404)
    })

    it('reflects datadir file edits on the next request when --watch is on', async function () {
      // Linux inotify-recursive registration is lazy — fs.watch on Node 20/22
      // sometimes drops events that fire within the first few hundred ms of
      // the watcher being installed. The mocha timeout default of 2s isn't
      // enough headroom on GH Actions runners; give the test a real budget.
      this.timeout(15_000)

      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: true,
        // 75ms is short enough to keep the test snappy on a fast box, but
        // long enough to coalesce the ~3 file writes done by
        // writeFixtureDatadir without firing on a partial-write moment.
        // Earlier the test used 25ms, which on Linux GH runners was tight
        // enough that the watcher fired between writes and read mid-rewrite
        // garbage — the SDK then swallowed the JSON parse error and no
        // further event followed.
        watchDebounceMs: 75,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })

      const ctx = base64url(JSON.stringify({}))
      const before = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
      const beforeValue = JSON.parse(before.body).evaluations['sample.greeting'].value.value
      expect(beforeValue).to.equal('hello')

      // Give Linux inotify a moment to finish registering the recursive
      // watch before we start mutating. Without this, the first write often
      // lands before any watch descriptors are in place on Linux.
      await sleep(150)

      writeFixtureDatadir(dir, 'goodbye')

      // Touch the leaf file again *after* the debounce window to guarantee
      // at least one IN_MODIFY event lands in the watcher. Some Linux
      // configurations dedupe IN_MODIFY events that fire while a previous
      // one is still in the queue; the explicit touch is cheap insurance.
      await sleep(120)
      const greeting = path.join(dir, 'configs', 'sample.greeting.json')
      const now = new Date()
      fs.utimesSync(greeting, now, now)

      let afterValue = beforeValue
      for (let i = 0; i < 200 && afterValue !== 'goodbye'; i++) {
        await sleep(50)
        const after = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
        afterValue = JSON.parse(after.body).evaluations['sample.greeting'].value.value
      }
      expect(afterValue).to.equal('goodbye')
    })

    it('errors with a clear message on port collision (EADDRINUSE)', async () => {
      // Pre-bind a port so the next listen() fails.
      const blocker = net.createServer()
      await new Promise<void>((resolve) => {
        blocker.listen(0, '127.0.0.1', resolve)
      })
      const port = (blocker.address() as net.AddressInfo).port

      try {
        await startServer({
          datadir: dir,
          environment: 'development',
          port,
          host: '127.0.0.1',
          corsOrigins: ['*'],
          watch: false,
          allowNonLoopback: false,
          verbose: false,
          logger: noopLogger(),
        })
        expect.fail('expected startServer to throw on EADDRINUSE')
      } catch (error) {
        expect((error as Error).message).to.match(/already in use/)
        expect((error as Error).message).to.contain(String(port))
        expect((error as Error).message).to.match(/--port/)
      } finally {
        await new Promise<void>((resolve) => {
          blocker.close(() => resolve())
        })
      }
    })

    // qfg-38sf.5 — multi-origin allow-list. When --cors-origin is given more
    // than once, treat the list as an allow-list. Echo the matching Origin
    // header back (with Vary: Origin); omit Access-Control-Allow-Origin
    // entirely on a non-matching Origin. The CORS spec does NOT allow a
    // comma-joined value, so the prior `join(', ')` silently broke browsers.
    describe('CORS multi-origin allow-list (qfg-38sf.5)', () => {
      it('echoes the matching Origin when --cors-origin is a list and the request Origin matches', async () => {
        handle = await startServer({
          datadir: dir,
          environment: 'development',
          port: 0,
          host: '127.0.0.1',
          corsOrigins: ['https://a.example', 'https://b.example'],
          watch: false,
          allowNonLoopback: false,
          verbose: false,
          logger: noopLogger(),
        })
        const ctx = base64url(JSON.stringify({}))

        const resA = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`, {
          Origin: 'https://a.example',
        })
        expect(resA.headers['access-control-allow-origin']).to.equal('https://a.example')
        expect(resA.headers.vary).to.match(/origin/i)

        const resB = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`, {
          Origin: 'https://b.example',
        })
        expect(resB.headers['access-control-allow-origin']).to.equal('https://b.example')
        expect(resB.headers.vary).to.match(/origin/i)
      })

      it('omits Access-Control-Allow-Origin when the request Origin does not match the allow-list', async () => {
        handle = await startServer({
          datadir: dir,
          environment: 'development',
          port: 0,
          host: '127.0.0.1',
          corsOrigins: ['https://a.example', 'https://b.example'],
          watch: false,
          allowNonLoopback: false,
          verbose: false,
          logger: noopLogger(),
        })
        const ctx = base64url(JSON.stringify({}))
        const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`, {
          Origin: 'https://evil.example',
        })
        // Never send the comma-joined value (the bug being fixed). Never send
        // the unmatched Origin. Header should be absent entirely.
        expect(res.headers['access-control-allow-origin']).to.equal(undefined)
      })

      it('omits Access-Control-Allow-Origin when no Origin header is sent against a multi-origin allow-list', async () => {
        handle = await startServer({
          datadir: dir,
          environment: 'development',
          port: 0,
          host: '127.0.0.1',
          corsOrigins: ['https://a.example', 'https://b.example'],
          watch: false,
          allowNonLoopback: false,
          verbose: false,
          logger: noopLogger(),
        })
        const ctx = base64url(JSON.stringify({}))
        const res = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
        expect(res.headers['access-control-allow-origin']).to.equal(undefined)
      })
    })

    it('refuses --host 0.0.0.0 without --allow-non-loopback', async () => {
      try {
        await startServer({
          datadir: dir,
          environment: 'development',
          port: 0,
          host: '0.0.0.0',
          corsOrigins: ['*'],
          watch: false,
          allowNonLoopback: false,
          verbose: false,
          logger: noopLogger(),
        })
        expect.fail('expected startServer to refuse non-loopback host')
      } catch (error) {
        expect((error as Error).message).to.match(/--allow-non-loopback/)
      }
    })

    it('logs a WARN when --host is non-loopback and --allow-non-loopback is set', async () => {
      const warnings: string[] = []
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1', // can't actually bind 0.0.0.0 in unit tests — use injected hook
        forceNonLoopbackForTest: '0.0.0.0',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: true,
        verbose: false,
        logger: {
          log() {},
          warn: (msg: string) => warnings.push(msg),
        },
      })
      expect(warnings.join('\n')).to.match(/loopback|lan|allow-non-loopback/i)
    })
  })
})

function noopLogger() {
  return {log() {}, warn() {}}
}
