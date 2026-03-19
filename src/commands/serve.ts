import {Args, Flags} from '@oclif/core'
import {ConfigType} from '@quonfig/node'
import type {Quonfig} from '@quonfig/node'
import * as fs from 'node:fs'
import http, {IncomingMessage, ServerResponse} from 'node:http'

import {BaseCommand} from '../index.js'
import {initQuonfig} from '../quonfig.js'
import {valueTypeStringForConfig} from '../quonfig-common/src/valueType.js'
import {javaScriptClientFormattedContextToContext} from '../util/context.js'

const allowCORSPreflight = (res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-quonfig-client-version, authorization')
}

const ALWAYS_SEND_CONFIG_TYPES = new Set([ConfigType.FeatureFlag, ConfigType.LogLevel])

const base64ToBytes = (base64: string): Uint8Array => {
  const binString = Buffer.from(base64, 'base64').toString('binary')
  return Uint8Array.from(binString, (m) => m.codePointAt(0) as number)
}

export default class Serve extends BaseCommand {
  static args = {
    'data-file': Args.string({description: 'file to read', required: true}),
  }

  static description = `Serve a datafile on a local port

  You can download a datafile using the \`download\` command.

  You'll need to update your JavaScript (or React) client to point to this server.

  e.g. \`endpoints: ["http://localhost:3099"],\`
`

  static examples = ['<%= config.bin %> <%= command.id %> ./quonfig.test.588.config.json --port=3099 ']

  static flags = {
    port: Flags.integer({default: 3099, description: 'port to serve on'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(Serve)

    const file = args['data-file']

    if (!fs.existsSync(file)) {
      return this.error(`File not found: ${file}`)
    }

    let quonfig: Quonfig | void

    try {
      quonfig = await initQuonfig(this, file)

      if (!quonfig) {
        throw new Error('Quonfig not initialized')
      }
    } catch (error_) {
      const error = error_ as Error

      if (/No projectEnvId found in config/.test(error.message) || /Unexpected end of JSON input/.test(error.message)) {
        return this.error(
          `${error.message}\nYour download file seems invalid or corrupt. Please redownload your datafile.`,
        )
      }

      return this.error(error as Error)
    }

    const {port} = flags

    const server = http.createServer(this.requestHandler(quonfig))

    server.listen(port, (err?: Error) => {
      if (err) {
        return this.err(err)
      }

      console.log(`Server is listening on ${port}. Press ctrl-c to stop.`)
    })
  }

  private requestHandler(quonfig: Quonfig) {
    return (req: IncomingMessage, res: ServerResponse) => {
      allowCORSPreflight(res)

      // Handle CORS preflight request
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const match = req.url?.match(/^\/?\/configs\/eval-with-context\/(.+)$/)

      if (req.method === 'GET' && match) {
        const encodedContext = match[1].split('?')[0]

        console.log(`Received context: ${encodedContext}`)
        console.log(`Decoded context: ${decodeURIComponent(encodedContext)}`)
        const decoded = new TextDecoder().decode(base64ToBytes(decodeURIComponent(encodedContext)))

        const context = javaScriptClientFormattedContextToContext(JSON.parse(decoded))

        this.log(`${new Date().toISOString()}: Provided context: ${JSON.stringify(context)}`)

        const config: Record<string, Record<string, unknown>> = {}

        for (const key of quonfig.keys()) {
          const raw = quonfig.rawConfig(key)

          if (raw && (ALWAYS_SEND_CONFIG_TYPES.has(raw.type) || raw.sendToClientSdk)) {
            const valueType = valueTypeStringForConfig(raw) ?? '?'

            config[key] = {value: {[valueType]: quonfig.get(key, context)}}
          }
        }

        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({evaluations: config}))
      } else {
        this.verboseLog(`No handler for ${req.method} ${req.url}`)
        res.writeHead(404, {'Content-Type': 'text/plain'})
        res.end('Not Found. You can only GET /configs/eval-with-context/<context>')
      }
    }
  }
}
