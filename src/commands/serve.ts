/**
 * `qfg serve` — Node-native local server that exposes a datadir over the
 * same HTTP protocol the browser SDKs already speak. Designed to close the
 * "browser SDKs can't read a local datadir" gap (epic qfg-38sf, plan
 * project/plans/qfg-serve.md, Option A).
 */

import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {resolveDatadirForServe} from '../serve/datadir-discovery.js'
import {startServer} from '../serve/server.js'

export default class Serve extends BaseCommand {
  static description = `Serve a local datadir over HTTP to browser/RN SDKs.

Reads configs from a local datadir and exposes them at
\`GET /api/v2/configs/eval-with-context/{base64url(ctx)}\`. Point your
browser SDK at the resulting URL (\`http://localhost:6580\` by default)
and the same client code that talks to api-delivery in production will
work unmodified.

Telemetry is intentionally not served — qfg serve has no Quonfig backend
behind it. Disable client-side telemetry with
\`collectEvaluationSummaries: false\` (and \`contextUploadMode: "none"\`),
or point the SDK's \`telemetryUrl\` at a real endpoint.

The server is bound to 127.0.0.1 by default; pass --allow-non-loopback
to confirm a LAN-reachable bind.`

  static examples = [
    '<%= config.bin %> serve',
    '<%= config.bin %> serve --datadir ./our-config --environment production',
    '<%= config.bin %> serve --port 6581 --frontend-sdk-key PUBLIC_KEY',
  ]

  static flags = {
    datadir: Flags.string({
      description: 'Datadir to serve (defaults to ./our-config, then ./.quonfig, then errors). Honors QUONFIG_DIR.',
    }),
    environment: Flags.string({
      default: 'development',
      description: 'Which environment slug to evaluate. Honors QUONFIG_ENVIRONMENT.',
    }),
    port: Flags.integer({
      default: 6580,
      description: 'TCP port to listen on. Errors on collision; pass --port <n> to retry.',
    }),
    host: Flags.string({
      default: '127.0.0.1',
      description: 'Bind address. Loopback by default; non-loopback requires --allow-non-loopback.',
    }),
    'frontend-sdk-key': Flags.string({
      description:
        'If set, every request must present Authorization: Basic 1:<key>. ' +
        'If unset, the server is open (matches the "datadir is the source of truth" mental model).',
    }),
    'cors-origin': Flags.string({
      default: ['*'],
      description: 'Allowed CORS origin (repeatable). Default is *; required when binding to a non-loopback host.',
      multiple: true,
    }),
    watch: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Reload the envelope when the datadir changes. --no-watch disables.',
    }),
    'allow-non-loopback': Flags.boolean({
      default: false,
      description: 'Confirm a LAN-reachable bind. Required when --host is not loopback.',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Serve)

    const envEnvironment = process.env.QUONFIG_ENVIRONMENT
    const environment = flags.environment ?? envEnvironment ?? 'development'

    const resolved = resolveDatadirForServe({
      flagDatadir: flags.datadir,
      envDatadir: process.env.QUONFIG_DIR,
      cwd: process.cwd(),
    })
    if (resolved.kind === 'error') {
      return this.err(resolved.message)
    }

    const datadir = resolved.dir

    if (this.isVerbose) {
      this.verboseLog('Serve', {datadir, environment, port: flags.port, host: flags.host})
    }

    const logger = {
      log: (msg: string) => this.log(msg),
      warn: (msg: string) => this.logToStderr(msg),
    }

    let handle
    try {
      handle = await startServer({
        datadir,
        environment,
        port: flags.port,
        host: flags.host,
        frontendSdkKey: flags['frontend-sdk-key'],
        corsOrigins: flags['cors-origin'],
        watch: flags.watch,
        allowNonLoopback: flags['allow-non-loopback'],
        verbose: this.isVerbose,
        logger,
      })
    } catch (error) {
      return this.err((error as Error).message)
    }

    const url = `http://${flags.host}:${handle.port}`
    this.log(`qfg serve listening on ${url}`)
    this.log(`  datadir:     ${datadir}`)
    this.log(`  environment: ${environment}`)
    if (flags['frontend-sdk-key']) {
      this.log(`  auth:        required (Authorization: Basic 1:<key>)`)
    } else {
      this.log(`  auth:        none (datadir served openly)`)
    }
    this.log('')
    this.log('Point your browser SDK at the URL above:')
    this.log(`  init({ apiUrls: ["${url}"] })`)
    this.log('Press Ctrl-C to stop.')

    // Block until the process is killed. The server is already accepting
    // connections; we just need to keep the event loop alive.
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        this.log('\nqfg serve shutting down...')
        try {
          await handle.close()
        } finally {
          resolve()
        }
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })

    return {datadir, environment, url}
  }
}
