/**
 * HTTP server for `qfg serve`. Boots a single `@quonfig/node` Quonfig client
 * with `{datadir, dataDirAutoReload}` so file changes flow into a shared
 * snapshot (mirror of the SDK's `ConfigStore`). All requests evaluate against
 * that snapshot — see plan project/plans/qfg-serve.md §5 ("Integration with
 * auto-reload work").
 *
 * Bound by default to 127.0.0.1. Auth and CORS are configured per plan §4.
 */

import * as http from 'node:http'

import {ConfigStore, Evaluator, Quonfig} from '@quonfig/node'
import type {ConfigEnvelope, ConfigResponse} from '@quonfig/node'

import {handleEvalContext} from './handlers/evalContext.js'

export interface Logger {
  log: (msg: string) => void
  warn: (msg: string) => void
}

export interface ServeOptions {
  allowNonLoopback: boolean
  corsOrigins: string[]
  datadir: string
  environment: string
  /**
   * Test-only escape hatch — startServer treats this string as the bind host
   * for the loopback / non-loopback policy check, while still actually
   * binding to `host`. Lets unit tests assert the WARN path without binding
   * 0.0.0.0 in CI (which some networks forbid). NOT a public option.
   */
  forceNonLoopbackForTest?: string
  frontendSdkKey?: string
  host: string
  logger: Logger
  port: number
  verbose: boolean
  watch: boolean
  /** Override the SDK's 200ms default debounce; lets tests check the watch path quickly. */
  watchDebounceMs?: number
}

export interface ServeHandle {
  /** Stop watching, close all sockets, await SDK close. Idempotent. */
  close(): Promise<void>
  host: string
  port: number
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const isLoopback = (host: string): boolean => LOOPBACK_HOSTS.has(host)

export async function startServer(opts: ServeOptions): Promise<ServeHandle> {
  // Loopback policy — plan §4 auth note. Refuse non-loopback binds without
  // an explicit opt-in; this prevents the developer from accidentally
  // exposing an unauthenticated server to their LAN.
  const policyHost = opts.forceNonLoopbackForTest ?? opts.host
  if (!isLoopback(policyHost) && !opts.allowNonLoopback) {
    throw new Error(
      `Refusing to bind ${opts.host}: pass --allow-non-loopback to confirm the server should be reachable from the LAN.`,
    )
  }
  if (!isLoopback(policyHost) && opts.allowNonLoopback) {
    opts.logger.warn(
      `qfg serve is bound to ${opts.host}: any device on your LAN can reach it. ` +
        `Anyone with the URL gets the datadir contents; do not run this on an untrusted network ` +
        `without --frontend-sdk-key.`,
    )
  }

  // The Quonfig client owns datadir loading + file watching via the
  // `dataDirAutoReload` option that landed in sdk-node 0.0.30 (qfg-zx3y).
  // We hold a parallel ConfigStore + Evaluator that mirror the client's
  // internal state so the eval handler can call evaluator.evaluateConfig()
  // directly — Quonfig's public surface (`get`, `rawConfig`, `getRawMatch`)
  // doesn't return the typed Value object the EvalEnvelope shape needs.
  let store = new ConfigStore()
  let evaluator = new Evaluator(store)
  const environment = opts.environment
  let version = ''

  const refreshSnapshot = (client: Quonfig): void => {
    // Pull every config out of the client and stuff it into our parallel
    // store. `keys()` and `rawConfig()` are public; they return the
    // ConfigResponse exactly as the client loaded it from disk.
    //
    // NOTE: the SDK fires `onConfigUpdate` from inside its initial
    // `loadLocalData()` call, BEFORE `init()` has flipped `initialized` to
    // true. Calling `client.keys()` during that window would throw "Not
    // initialized." We swallow that one case here — the post-init manual
    // refresh covers the initial load.
    let keys: string[]
    try {
      keys = client.keys()
    } catch {
      return
    }
    const configs: ConfigResponse[] = []
    for (const key of keys) {
      const cfg = client.rawConfig(key)
      if (cfg) configs.push(cfg)
    }
    const envelope: ConfigEnvelope = {
      configs,
      meta: {version, environment},
    }
    store = new ConfigStore()
    evaluator = new Evaluator(store)
    store.loadFromDatafile(envelope)
  }

  // qfg-zx3y's auto-reload fires `onConfigUpdate` after the SDK has installed
  // the new envelope. We re-sync our snapshot from the client at that point.
  const client = new Quonfig({
    sdkKey: 'qfg-serve-local',
    datadir: opts.datadir,
    environment: opts.environment,
    dataDirAutoReload: opts.watch,
    dataDirAutoReloadDebounceMs: opts.watchDebounceMs,
    // Telemetry is intentionally OFF — qfg serve has no Quonfig backend to
    // post to, and the SDK's default-on collectors would just buffer forever.
    collectEvaluationSummaries: false,
    contextUploadMode: 'none',
    enableSSE: false,
    fallbackPollEnabled: false,
    onConfigUpdate() {
      version = `datadir:${opts.datadir}#${Date.now()}`
      refreshSnapshot(client)
      if (opts.verbose) opts.logger.log(`qfg-serve: reloaded datadir (version=${version})`)
    },
  })

  await client.init()

  // Initial snapshot — the SDK fires onConfigUpdate during init() so this is
  // mostly insurance against an init path that doesn't, but it's cheap.
  if (store.keys().length === 0) {
    version = `datadir:${opts.datadir}#${Date.now()}`
    refreshSnapshot(client)
  }

  const corsOrigin = opts.corsOrigins.includes('*') ? '*' : opts.corsOrigins.join(', ')
  const frontendFilter = Boolean(opts.frontendSdkKey)

  const server = http.createServer(async (req, res) => {
    if (opts.verbose) {
      opts.logger.log(`qfg-serve: ${req.method} ${req.url}`)
    }

    // CORS — emit on every response, including 401 and 404, so browser
    // clients surface the real status code instead of an opaque CORS error.
    res.setHeader('Access-Control-Allow-Origin', corsOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Expose-Headers', 'ETag')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Auth — plan §4. If --frontend-sdk-key was set, every non-OPTIONS
    // request must present `Authorization: Basic base64("1:<key>")`. If it
    // wasn't set, no check.
    if (opts.frontendSdkKey) {
      const ok = checkBasicAuth(req.headers.authorization, opts.frontendSdkKey)
      if (!ok) {
        res.writeHead(401, {
          'Content-Type': 'text/plain',
          'WWW-Authenticate': 'Basic realm="qfg-serve"',
        })
        res.end('unauthorized')
        return
      }
    }

    const url = req.url ?? '/'
    const [pathOnly] = url.split('?')

    // GET /api/v2/configs/eval-with-context/{base64url}
    const evalPrefix = '/api/v2/configs/eval-with-context/'
    if (req.method === 'GET' && pathOnly.startsWith(evalPrefix)) {
      const ctxToken = pathOnly.slice(evalPrefix.length)
      if (!ctxToken) {
        res.writeHead(400, {'Content-Type': 'text/plain'})
        res.end('missing context token')
        return
      }
      try {
        await handleEvalContext(req, res, ctxToken, {
          getSnapshot: () => ({store, evaluator, environment, version, frontendFilter}),
        })
      } catch (error) {
        opts.logger.warn(`qfg-serve: eval-with-context handler threw: ${(error as Error).message}`)
        if (!res.headersSent) {
          res.writeHead(500, {'Content-Type': 'text/plain'})
          res.end('internal error')
        }
      }
      return
    }

    // POST /api/v1/telemetry/  → 404 with a helpful body. Plan §2: we
    // intentionally don't accept telemetry — silently 200-OK-and-dropping
    // would hide a misconfig.
    if (req.method === 'POST' && pathOnly === '/api/v1/telemetry/') {
      res.writeHead(404, {'Content-Type': 'application/json'})
      res.end(
        JSON.stringify({
          error: 'qfg serve does not accept telemetry',
          hint:
            'Disable client-side telemetry by passing `collectEvaluationSummaries: false` ' +
            '(and `contextUploadMode: "none"`) to your SDK init, or point the SDK\'s ' +
            'telemetryUrl at a real Quonfig telemetry endpoint.',
        }),
      )
      return
    }

    res.writeHead(404, {'Content-Type': 'text/plain'})
    res.end('not found')
  })

  // Bind. EADDRINUSE is the only common failure here; surface it with a
  // pointed message so the developer doesn't have to read a stack trace.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${opts.port} is already in use. Pass --port <n> to pick another.`))
      } else {
        reject(err)
      }
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(opts.port, opts.host)
  })

  const boundPort = (server.address() as {port: number}).port
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    try {
      await client.close()
    } catch {
      /* best effort */
    }
  }

  return {port: boundPort, host: opts.host, close}
}

/**
 * Validate `Authorization: Basic base64("1:<key>")` against the configured
 * SDK key. The browser SDKs build this header in
 * `sdk-javascript/src/apiHelpers.ts:7`.
 */
function checkBasicAuth(header: string | undefined, expectedKey: string): boolean {
  if (!header || !header.toLowerCase().startsWith('basic ')) return false
  const b64 = header.slice('basic '.length).trim()
  let decoded: string
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return false
  }
  const expected = `1:${expectedKey}`
  // Plain equality — the frontend SDK key is a publicly-available secret by
  // design (plan §4) so this isn't a security boundary; the check exists to
  // catch a "forgot the key on the frontend" misconfig.
  return decoded === expected
}
