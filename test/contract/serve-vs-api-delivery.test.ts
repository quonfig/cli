/**
 * Contract test — `qfg serve` ↔ `api-delivery` (FIXTURE_DIR mode).
 *
 * Per plan project/plans/qfg-serve.md §9 and bead qfg-38sf.2. This is the
 * drift defense. Without it, wire-protocol changes in api-delivery silently
 * diverge from `qfg serve` and a developer sees "works locally, broken in
 * prod" (or vice versa).
 *
 * What it does:
 *   1. Writes a tiny on-disk datadir (2 configs: one feature flag, one config
 *      with sendToClientSdk=true) + a fixture-sdk-keys.json file mapping a
 *      frontend SDK key to a workspace + environment.
 *   2. Boots `qfg serve` in-process via startServer() against the datadir.
 *   3. Spawns the api-delivery Go binary in FIXTURE_DIR mode against the
 *      same datadir + the same fixture-sdk-keys.json (via SDK_KEYS_FILE).
 *   4. For each context shape (anonymous, user with key, user with extra
 *      attributes), hits both servers with `Authorization: Basic 1:<key>`,
 *      parses the EvalEnvelope, and diffs field-by-field.
 *
 * Masking: `meta.version` and `meta.workspaceId` are masked before diffing —
 * the two servers compute these differently today, tracked as a known
 * divergence in bead qfg-38sf.6 (envelope alignment). The rest of the
 * envelope — `evaluations.*` and `meta.environment` — must match exactly.
 *
 * Skip behavior: the api-delivery binary path comes from the `API_DELIVERY_BIN`
 * env var. If it's unset or the file doesn't exist, the whole suite skips with
 * a clear message. CI builds the binary in a sibling api-delivery/ checkout
 * (see `.github/workflows/test.yml` — job `contract-test`) and exports the
 * path. Locally, set it manually:
 *
 *   cd ../api-delivery && GOWORK=off go build -o /tmp/api-delivery-bin ./cmd/server
 *   API_DELIVERY_BIN=/tmp/api-delivery-bin yarn mocha test/contract/*.test.ts
 *
 * Fixture set (deliberately narrow — bigger fixtures = bigger drift surface):
 *   - feature flag, value type bool, ALWAYS_TRUE
 *   - config (string), sendToClientSdk=true, ALWAYS_TRUE
 *   - config (string), sendToClientSdk=true, TARGETING_MATCH on user.email
 *
 * Context shapes (2-3 representative — same reason):
 *   - anonymous (no user context)
 *   - user with key only
 *   - user with key + email matching the targeting rule
 */

import {ChildProcess, spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import {expect} from 'chai'

import {startServer, ServeHandle} from '../../src/serve/server.js'

const FRONTEND_SDK_KEY = 'test-frontend-key'
// sha512("test-frontend-key") — same hash used in api-delivery/testdata/fixture-sdk-keys.json.
// Recomputed in node -e to keep this test self-contained; if you change the key, update this hash.
const FRONTEND_SDK_KEY_SHA512 =
  'e0486a496321aab300e21cc1cf6229dec3ce469550f1fc2e27f03969758b40f38ecdad587b0455acd889186551de694b3eaab16a07f39a73473306de6e351c1e'

const ENVIRONMENT = 'Production'
const WORKSPACE_ID = 'contract-test-workspace'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-contract-'))
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function basicAuth(key: string): string {
  return 'Basic ' + Buffer.from(`1:${key}`).toString('base64')
}

function noopLogger() {
  return {
    log() {
      // intentionally empty — silence test logs
    },
    warn() {
      // intentionally empty — silence test logs
    },
  }
}

/**
 * Write the narrow contract-test fixture set into `datadir`. Three configs is
 * the minimum that covers (a) feature flag bypassing the frontend filter,
 * (b) sendToClientSdk=true config passing the filter, and (c) a targeting
 * rule that hits TARGETING_MATCH. We intentionally do NOT load
 * integration-test-data wholesale: bigger fixtures = more places the
 * envelope could drift = more flake. Narrow is correct here.
 */
function writeContractFixture(datadir: string): void {
  fs.mkdirSync(path.join(datadir, 'configs'), {recursive: true})
  fs.mkdirSync(path.join(datadir, 'feature-flags'), {recursive: true})
  fs.writeFileSync(path.join(datadir, 'quonfig.json'), JSON.stringify({environments: [ENVIRONMENT]}), 'utf8')

  // (a) Feature flag, ALWAYS_TRUE — bool. Bypasses the frontend sendToClientSdk
  // filter by virtue of being type=feature_flag (matches api-delivery's
  // configs.go and qfg serve's evalContext.ts identical filter).
  fs.writeFileSync(
    path.join(datadir, 'feature-flags', 'contract.flag.json'),
    JSON.stringify({
      id: '10000000000000001',
      projectId: '999',
      key: 'contract.flag',
      type: 'feature_flag',
      valueType: 'bool',
      sendToClientSdk: false,
      default: {
        rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}],
      },
    }),
    'utf8',
  )

  // (b) String config, sendToClientSdk=true, ALWAYS_TRUE. Exercises STATIC reason.
  fs.writeFileSync(
    path.join(datadir, 'configs', 'contract.greeting.json'),
    JSON.stringify({
      id: '10000000000000002',
      projectId: '999',
      key: 'contract.greeting',
      type: 'config',
      valueType: 'string',
      sendToClientSdk: true,
      default: {
        rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'hello'}}],
      },
    }),
    'utf8',
  )

  // (c) String config with a real targeting rule (email endsWith). Exercises
  // TARGETING_MATCH reason — the only contract field where ruleIndex is emitted.
  fs.writeFileSync(
    path.join(datadir, 'configs', 'contract.targeted.json'),
    JSON.stringify({
      id: '10000000000000003',
      projectId: '999',
      key: 'contract.targeted',
      type: 'config',
      valueType: 'string',
      sendToClientSdk: true,
      default: {
        rules: [
          {
            criteria: [
              {
                propertyName: 'user.email',
                operator: 'PROP_ENDS_WITH_ONE_OF',
                valueToMatch: {type: 'string_list', value: ['@quonfig.com']},
              },
            ],
            value: {type: 'string', value: 'staff'},
          },
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'string', value: 'public'},
          },
        ],
      },
    }),
    'utf8',
  )
}

/**
 * Find a free TCP port by binding to 0 and reading back the kernel-assigned
 * port. We then immediately release the socket; there is a small race where
 * another process could grab it, but for a single-machine test run with one
 * port-grab per server, that's acceptable. Alternative would be to pass
 * port=0 to api-delivery, but its FIXTURE_DIR boot logs port assignment to
 * stdout in a way that's awkward to parse — kernel-pick-and-pass is simpler.
 */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('failed to pick port')))
      }
    })
  })
}

async function httpRequest(
  port: number,
  pathName: string,
  headers: Record<string, string>,
): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method: 'GET', path: pathName, headers}, (res) => {
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
      })
      res.on('end', () => resolve({status: res.statusCode ?? 0, body: buf}))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Spawn api-delivery in FIXTURE_DIR mode. Waits for the "server starting on"
 * log line on stderr/stdout (the Go binary writes startup logs to stdout via
 * the standard `log` package) before resolving. Times out after 10s.
 *
 * We forward both stdout and stderr to in-memory buffers so a failing test
 * can attach them to the assertion message.
 */
async function spawnApiDelivery(args: {
  binary: string
  fixtureDir: string
  sdkKeysFile: string
  port: number
}): Promise<{child: ChildProcess; logs: () => string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.binary, [], {
      env: {
        ...process.env,
        PORT: String(args.port),
        FIXTURE_DIR: args.fixtureDir,
        SDK_KEYS_FILE: args.sdkKeysFile,
        // Disable telemetry forwarding — fixture mode default, but be explicit.
        QUONFIG_TELEMETRY_URL: '',
        // Disable OTEL exporter — without this the binary spams 5s connection
        // retry warnings to localhost:4318 (which isn't running in tests).
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', // unreachable; exporter just buffers silently
        GOWORK: 'off',
      },
      // Don't share the parent's stdio — capture so we can wait for the
      // "server starting on" line and surface failures.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let buf = ''
    let resolved = false
    const onLine = (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      if (!resolved && buf.includes('server starting on')) {
        resolved = true
        resolve({child, logs: () => buf})
      }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)
    child.on('exit', (code, signal) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`api-delivery exited before ready (code=${code} signal=${signal}). Logs:\n${buf}`))
      }
    })
    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })

    setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill('SIGKILL')
        reject(new Error(`api-delivery did not start within 10s. Logs:\n${buf}`))
      }
    }, 10_000)
  })
}

async function killProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    // Force-kill if SIGTERM doesn't take effect within 2s.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2000)
  })
}

/**
 * Mask the fields that the two servers compute differently. Tracked as
 * known drift in bead qfg-38sf.6 (envelope alignment):
 *   - meta.version: qfg serve emits "datadir:<path>#<ms-epoch>",
 *     api-delivery emits "fixture".
 *   - meta.workspaceId: api-delivery does not emit it from the fixture path
 *     today; qfg serve also doesn't. Mask defensively for future-proofing.
 *
 * IMPORTANT: We MUTATE in place (well, on a deep clone) rather than
 * reconstruct the envelope. A reconstruction would silently drop any
 * surprise extra top-level fields a future change might add — defeating the
 * whole point of this drift defense. With in-place masking, an extra field
 * (e.g. `envelope.surprise = "..."`) flows through to the deep-equal check
 * and fails the test.
 */
function maskKnownDrift(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== 'object') return envelope
  // Deep clone via JSON round-trip — fine for plain envelope data (no
  // Dates, no functions, no Buffers in the on-wire shape).
  const cloned = JSON.parse(JSON.stringify(envelope)) as {meta?: Record<string, unknown>}
  if (cloned.meta) {
    if ('version' in cloned.meta) cloned.meta.version = '<masked>'
    if ('workspaceId' in cloned.meta) cloned.meta.workspaceId = '<masked>'
  }
  return cloned
}

const apiDeliveryBin = process.env.API_DELIVERY_BIN ?? ''
const apiDeliveryAvailable = Boolean(apiDeliveryBin) && fs.existsSync(apiDeliveryBin)

;(apiDeliveryAvailable ? describe : describe.skip)(
  'contract: qfg serve ↔ api-delivery (FIXTURE_DIR)',
  // Mocha needs a non-arrow function so `this.timeout()` resolves to the suite.
  function () {
    // Booting two servers + cold-loading a Go binary takes ~2-3s. Give the
    // before/after hooks room without breaking the 30s bead acceptance budget.
    this.timeout(30_000)

    let datadir: string
    let sdkKeysFile: string
    let qfgServeHandle: ServeHandle | undefined
    let apiDeliveryChild: ChildProcess | undefined
    let apiDeliveryPort: number
    let qfgServePort: number
    let apiDeliveryLogs: () => string = () => ''

    before(async () => {
      if (!apiDeliveryAvailable) {
        console.log(
          'contract test skipped — set API_DELIVERY_BIN to the api-delivery binary path to run. ' +
            '(cd ../api-delivery && GOWORK=off go build -o /tmp/api-delivery-bin ./cmd/server)',
        )
        return
      }

      datadir = tmpDir()
      writeContractFixture(datadir)

      // SDK keys file. We use SDK_KEYS_FILE to point api-delivery at this
      // exact file rather than rely on the convention path
      // (../testdata/fixture-sdk-keys.json relative to FIXTURE_DIR) — keeps
      // the test self-contained.
      sdkKeysFile = path.join(datadir, '..', 'contract-sdk-keys.json')
      fs.writeFileSync(
        sdkKeysFile,
        JSON.stringify({
          keys: [
            {
              keyHash: FRONTEND_SDK_KEY_SHA512,
              workspaceId: WORKSPACE_ID,
              workspaceSlug: WORKSPACE_ID,
              orgSlug: 'contract-test-org',
              environment: ENVIRONMENT,
              keyType: 'frontend',
            },
          ],
        }),
        'utf8',
      )

      qfgServePort = await pickFreePort()
      apiDeliveryPort = await pickFreePort()

      qfgServeHandle = await startServer({
        datadir,
        environment: ENVIRONMENT,
        port: qfgServePort,
        host: '127.0.0.1',
        corsOrigins: ['*'],
        watch: false,
        allowNonLoopback: false,
        verbose: false,
        logger: noopLogger(),
        frontendSdkKey: FRONTEND_SDK_KEY,
      })

      const spawned = await spawnApiDelivery({
        binary: apiDeliveryBin,
        fixtureDir: datadir,
        sdkKeysFile,
        port: apiDeliveryPort,
      })
      apiDeliveryChild = spawned.child
      apiDeliveryLogs = spawned.logs
    })

    after(async () => {
      if (qfgServeHandle) await qfgServeHandle.close()
      if (apiDeliveryChild) await killProcess(apiDeliveryChild)
      if (datadir) fs.rmSync(datadir, {recursive: true, force: true})
      if (sdkKeysFile && fs.existsSync(sdkKeysFile)) fs.rmSync(sdkKeysFile, {force: true})
    })

    // The contract contexts. Each is exercised against both servers; the diff
    // is asserted in a single assertion per context to keep failure messages
    // pointed (mocha prints the failing it() block).
    const contracts: Array<{name: string; context: Record<string, Record<string, unknown>>}> = [
      {
        name: 'anonymous context (no user)',
        context: {},
      },
      {
        name: 'user with key only',
        context: {user: {key: 'u1'}},
      },
      {
        name: 'user with key + matching email (targets contract.targeted)',
        context: {user: {key: 'u2', email: 'staff@quonfig.com'}},
      },
    ]

    for (const c of contracts) {
      it(`matches api-delivery envelope: ${c.name}`, async () => {
        const token = base64url(JSON.stringify(c.context))
        const headers = {Authorization: basicAuth(FRONTEND_SDK_KEY)}
        const url = `/api/v2/configs/eval-with-context/${token}`

        const [qfgServeRes, apiDeliveryRes] = await Promise.all([
          httpRequest(qfgServePort, url, headers),
          httpRequest(apiDeliveryPort, url, headers),
        ])

        // Both servers must return 200 with a parseable envelope.
        expect(qfgServeRes.status, `qfg serve returned ${qfgServeRes.status}: ${qfgServeRes.body}`).to.equal(200)
        expect(
          apiDeliveryRes.status,
          `api-delivery returned ${apiDeliveryRes.status}: ${apiDeliveryRes.body}\nLogs:\n${apiDeliveryLogs()}`,
        ).to.equal(200)

        const qfgServeEnvelope = JSON.parse(qfgServeRes.body)
        const apiDeliveryEnvelope = JSON.parse(apiDeliveryRes.body)

        // Sanity: meta.environment must match exactly (not masked).
        expect(qfgServeEnvelope.meta.environment).to.equal(ENVIRONMENT)
        expect(apiDeliveryEnvelope.meta.environment).to.equal(ENVIRONMENT)

        // The core contract: after masking known drift (qfg-38sf.6), the
        // envelopes must be deeply equal.
        const qfgMasked = maskKnownDrift(qfgServeEnvelope)
        const apiMasked = maskKnownDrift(apiDeliveryEnvelope)
        expect(qfgMasked).to.deep.equal(apiMasked)
      })
    }
  },
)
