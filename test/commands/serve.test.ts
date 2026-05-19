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

    it('includes both client-sdk and non-client-sdk configs when no --frontend-sdk-key is set', async () => {
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
      expect(body.evaluations).to.have.property('sample.secret')
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

    it('reflects datadir file edits on the next request when --watch is on', async () => {
      handle = await startServer({
        datadir: dir,
        environment: 'development',
        port: 0,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: true,
        // Tighten the SDK debounce so the test doesn't sleep half a second
        // waiting for the default 200ms window to expire.
        watchDebounceMs: 25,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
      })

      const ctx = base64url(JSON.stringify({}))
      const before = await httpRequest(handle.port, 'GET', `/api/v2/configs/eval-with-context/${ctx}`)
      const beforeValue = JSON.parse(before.body).evaluations['sample.greeting'].value.value
      expect(beforeValue).to.equal('hello')

      // Mutate the datadir, then poll until the watcher catches up.
      writeFixtureDatadir(dir, 'goodbye')
      let afterValue = beforeValue
      for (let i = 0; i < 50 && afterValue !== 'goodbye'; i++) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50)
        })
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
