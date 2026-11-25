import type {SetupServer} from 'msw/node'

import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server as createServer} from '../responses/create.js'
import {server as getServer} from '../responses/get.js'
import {confidentialOverridePlaintext, server as infoServer} from '../responses/info.js'
import {server as setDefaultServer} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'
import * as qf1Writes from './secret-write-fixtures.js'

/**
 * Secret leak matrix (qfg-r3a47, from the qfg-38lp QA script).
 *
 * Every command that touches a secret or confidential value runs in each
 * output mode, and its stdout + stderr must never contain the plaintext. A
 * new command or output path that prints a value should get a row here.
 * `qfg get --reveal` is the one path meant to print plaintext and is left out;
 * `qfg history` renders server-side diffs and is covered by qfg-7usey.
 *
 * The qf1 write rows (qfg-mol-hle PR 3) also check every request the CLI
 * sent (bodies, including the commit message, the document's non-value
 * fields and every header-free field) and the thrown error, and expect a
 * refusal where one is due. No row may print or send a private key entry.
 * The masked prompt itself is covered by interactive-secret.test.ts.
 */

// Fake 64-hex keys, built at runtime so secret scanners don't flag test data.
// get's fixture ciphertext was encrypted with the '0123456789abcdef' key.
const ENCRYPTION_KEY = 'c8'.repeat(32)
const GET_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4)

const MODES: Array<{label: string; flags: string[]}> = [
  {flags: [], label: 'text'},
  {flags: ['--json'], label: '--json'},
  {flags: ['--verbose'], label: '--verbose'},
]

type Row = {
  argv: string[]
  /** The command must fail (a refusal); its error message is checked too. */
  fails?: boolean
  label: string
  sentinels: string[]
  /** Per-row fixture setup (workspace repo, server answers, stdin). */
  setup?: () => void
  teardown?: () => void
}

const Q = 'FAKE_MATRIX_QF1_SECRET_0'
const q = (n: number) => `${Q}${String(n).padStart(2, '0')}`
const ws =
  (files: Record<string, string> = {}) =>
  () => {
    qf1Writes.resetState()
    qf1Writes.workspace({'quonfig.json': qf1Writes.TWO_KEYSETS, ...files})
  }

const stored = () => ({'secrets/db.password.json': qf1Writes.storedSecret('db.password')})
const listedSecret =
  (files: Record<string, string> = stored()) =>
  () => {
    ws(files)()
    qf1Writes.state.listed = [{key: 'db.password', type: 'secret', valueType: 'string'}]
  }

const pushReply = (status: number, body: unknown) => () => {
  ws()()
  qf1Writes.state.push = {body, status}
}

const QF1_ROWS: Row[] = [
  {
    argv: ['create', 'm.a', '--secret', '--keyset', 'QUONFIG_KEYSET', `--value=${q(1)}`],
    label: 'create --secret (qf1, --value)',
    sentinels: [q(1)],
    setup: ws(),
  },
  {
    argv: ['create', 'm.b', '--secret', '--keyset', 'QUONFIG_KEYSET_PROD', '--value-stdin'],
    label: 'create --secret --value-stdin',
    sentinels: [q(2)],
    setup() {
      ws()()
      qf1Writes.setStdin(`${q(2)}\n`)
    },
    teardown: qf1Writes.restoreStdin,
  },
  {
    argv: ['create', 'm.c', '--secret', '--keyset', 'QUONFIG_KEYSET', '--value-from-env=QFG_MATRIX_QF1_SRC'],
    label: 'create --secret --value-from-env',
    sentinels: [q(3)],
    setup() {
      ws()()
      process.env.QFG_MATRIX_QF1_SRC = q(3)
    },
    teardown: () => delete process.env.QFG_MATRIX_QF1_SRC,
  },
  {
    argv: ['set-default', 'db.password', '--environment=production', '--secret', `--value=${q(4)}`, '--confirm'],
    label: 'set-default --secret (environment scope, inherited keyset)',
    sentinels: [q(4)],
    setup: ws(stored()),
  },
  {
    argv: ['set-default', 'db.password', '--environment=[Default]', '--secret', `--value=${q(5)}`, '--confirm'],
    label: 'set-default --secret (default scope)',
    sentinels: [q(5)],
    setup: ws(stored()),
  },
  {
    argv: ['set-default', 'db.password', '--environment=production', `--value=${q(6)}`, '--confirm'],
    label: 'set-default on a qf1 secret (auto-detected)',
    sentinels: [q(6)],
    setup: listedSecret(),
  },
  {
    argv: [
      'set-default',
      'db.password',
      '--environment=production',
      '--keyset',
      'QUONFIG_KEYSET',
      `--value=${q(7)}`,
      '--confirm',
      '--replace-targeting',
    ],
    label: 'set-default --keyset move with --replace-targeting',
    sentinels: [q(7)],
    setup: listedSecret(),
  },
  {
    argv: ['create', 'db.password', '--secret', `--value=${q(8)}`],
    fails: true,
    label: 'create --secret refused: key exists',
    sentinels: [q(8)],
    setup: ws(stored()),
  },
  {
    argv: ['create', 'm.d', '--secret', `--value=${q(9)}`],
    fails: true,
    label: 'create --secret refused: two keysets, no --keyset',
    sentinels: [q(9)],
    setup: ws(),
  },
  {
    argv: ['create', 'm.e', '--secret', '--secret-key-name=x.y', `--value=${q(10)}`],
    fails: true,
    label: 'create --secret refused: --secret-key-name',
    sentinels: [q(10)],
    setup: ws(),
  },
  {
    argv: ['create', 'm.f', '--secret', '--keyset', 'QUONFIG_KEYSET', `--value=${q(11)}`],
    fails: true,
    label: 'create --secret: default-tier lookup fails',
    sentinels: [q(11)],
    setup() {
      ws()()
      qf1Writes.state.access = 500
    },
  },
  {
    argv: ['set-default', 'db.password', '--environment=production', `--value=${q(12)}`, '--propose'],
    fails: true,
    label: 'set-default refused: --propose on a secret',
    sentinels: [q(12)],
    setup: listedSecret(),
  },
  {
    argv: ['set-default', 'db.password', '--environment=production', `--value=${q(13)}`, '--confirm'],
    fails: true,
    label: 'set-default refused: old-format config',
    sentinels: [q(13)],
    setup() {
      ws({'configs/db.password.json': JSON.stringify(qf1Writes.oldFormatConfig('db.password'))})()
      qf1Writes.state.listed = [{key: 'db.password', type: 'config', valueType: 'string'}]
      qf1Writes.state.documents = {'db.password': qf1Writes.oldFormatConfig('db.password')}
    },
  },
  {
    argv: ['set-default', 'db.password', '--environment=production', '--secret', `--value=${q(14)}`, '--confirm'],
    fails: true,
    label: 'set-default --secret refused: plain config',
    sentinels: [q(14)],
    setup() {
      ws({'configs/db.password.json': '{}'})()
      qf1Writes.state.listed = [{key: 'db.password', type: 'config', valueType: 'string'}]
    },
  },
  {
    argv: ['set-default', 'db.password', '--environment=production', `--value=${q(15)}`, '--no-interactive'],
    fails: true,
    label: 'set-default on a secret without --confirm, non-interactive',
    sentinels: [q(15)],
    setup: listedSecret(),
  },
  ...(
    [
      [403, {json: {data: {denials: [{path: 'secrets/m.g.json', reason: 'tier', requiredPermission: 'p'}]}}}],
      [400, {json: {message: 'Path not allowed by push allow-list: secrets/m.g.json'}}],
      [409, {json: {message: 'moved'}}],
      [500, {json: {message: 'boom'}}],
    ] as const
  ).map(([status, body], i): Row => ({
    argv: ['create', 'm.g', '--secret', '--keyset', 'QUONFIG_KEYSET', `--value=${q(20 + i)}`],
    fails: true,
    label: `create --secret: server answers ${status}`,
    sentinels: [q(20 + i)],
    setup: pushReply(status, body),
  })),
]

const GROUPS: Array<{
  after?: () => void
  env: Record<string, string | undefined>
  name: string
  rows: Row[]
  server: SetupServer
}> = [
  {
    after: qf1Writes.removeWorkspaces,
    env: {QUONFIG_KEYSET: undefined},
    name: 'qf1 secret writes',
    rows: QF1_ROWS,
    server: qf1Writes.server,
  },
  {
    env: {QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: ENCRYPTION_KEY},
    name: 'create',
    rows: [
      {
        argv: ['create', 'matrix.conf', '--type=string', '--confidential', '--value=FAKE_MATRIX_CREATE_CONF_02'],
        label: 'create --confidential',
        sentinels: ['FAKE_MATRIX_CREATE_CONF_02'],
      },
    ],
    server: createServer,
  },
  {
    env: {QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: ENCRYPTION_KEY},
    name: 'set-default',
    rows: [
      {
        argv: [
          'set-default',
          'jeffreys.test.key.reforge',
          '--environment=Staging',
          '--secret',
          '--value=FAKE_MATRIX_SD_SECRET_03',
          '--confirm',
        ],
        // A plain config: --secret now writes only secrets/, so it is refused.
        fails: true,
        label: 'set-default --secret on a plain config',
        sentinels: ['FAKE_MATRIX_SD_SECRET_03'],
      },
      {
        argv: ['set-default', 'robocop-secret', '--environment=Staging', '--value=FAKE_MATRIX_SD_AUTO_04', '--confirm'],
        // Old format (decryptWith): refused with the migrate pointer (Q6).
        fails: true,
        label: 'set-default on an old-format encrypted key (auto-detected)',
        sentinels: ['FAKE_MATRIX_SD_AUTO_04'],
      },
      {
        argv: [
          'set-default',
          'env-only.secret',
          '--environment=Staging',
          '--value=FAKE_MATRIX_SD_ENVONLY_05',
          '--confirm',
        ],
        fails: true,
        label: 'set-default on a key with old-format values only per-environment (auto-detected)',
        sentinels: ['FAKE_MATRIX_SD_ENVONLY_05'],
      },
      {
        argv: [
          'set-default',
          'confidential.plain',
          '--environment=Staging',
          '--confidential',
          '--value=FAKE_MATRIX_SD_CONF_06',
          '--confirm',
        ],
        label: 'set-default --confidential',
        sentinels: ['FAKE_MATRIX_SD_CONF_06', 'FAKE_OLD_CONFIDENTIAL_0001'],
      },
      {
        argv: [
          'set-default',
          'confidential.plain',
          '--environment=Staging',
          '--value=FAKE_MATRIX_SD_CONF_07',
          '--confirm',
        ],
        label: 'set-default on a confidential key (auto-detected)',
        sentinels: ['FAKE_MATRIX_SD_CONF_07', 'FAKE_OLD_CONFIDENTIAL_0001'],
      },
    ],
    server: setDefaultServer,
  },
  {
    env: {TEST_CLI_ENCRYPTION_KEY: GET_ENCRYPTION_KEY},
    name: 'get',
    rows: [
      {
        argv: ['get', 'encrypted.config', '--environment=[default]'],
        label: 'get on a secret',
        sentinels: ['test-secret'],
      },
      {
        argv: ['get', 'confidential.plain', '--environment=[default]'],
        label: 'get on a confidential value',
        sentinels: ['FAKE_CONF_PLAINTEXT_0001'],
      },
    ],
    server: getServer,
  },
  {
    env: {},
    name: 'info',
    rows: [
      {
        argv: ['info', 'a.confidential.config', '--exclude-evaluations'],
        label: 'info on a confidential value',
        sentinels: ['FAKE_INFO_CONFIDENTIAL_0001'],
      },
      {
        argv: ['info', 'a.secret.config', '--exclude-evaluations'],
        label: 'info on a secret with a confidential override',
        sentinels: [confidentialOverridePlaintext],
      },
    ],
    server: infoServer,
  },
]

describe('secret leak matrix (qfg-r3a47)', () => {
  before(() => setupTestAuth())
  after(() => cleanupTestAuth())

  for (const group of GROUPS) {
    describe(group.name, () => {
      // A request with no handler fails instead of reaching a real server.
      before(() => group.server.listen({onUnhandledRequest: 'error'}))
      afterEach(() => {
        group.server.resetHandlers()
        resetClientCache()
      })
      after(() => {
        group.server.close()
        group.after?.()
      })

      for (const row of group.rows) {
        for (const mode of MODES) {
          let thrown: unknown
          const base = test
            .env(group.env)
            .do(() => {
              thrown = undefined
              row.setup?.()
            })
            .finally(() => row.teardown?.())
            .stdout()
            .stderr()
            .command([...row.argv, ...mode.flags])
          const chain = row.fails
            ? base.catch((error) => {
                thrown = error
              })
            : base
          chain.it(`${row.label} [${mode.label}] prints no plaintext`, (ctx) => {
            const errorText = thrown instanceof Error ? `${thrown.message}\n${JSON.stringify(thrown)}` : ''
            const output = ctx.stdout + ctx.stderr + errorText
            expect(output, 'command printed nothing; is the fixture wired?').to.not.equal('')
            for (const sentinel of row.sentinels) expect(output).to.not.contain(sentinel)
            expect(output, 'no private key entry is ever printed').to.not.match(/qf1-priv-/)
            if (group.server === qf1Writes.server) {
              const sent = qf1Writes.allRequestText()
              for (const sentinel of row.sentinels)
                expect(sent, 'a request carried the plaintext').to.not.contain(sentinel)
              expect(sent, 'no request carries a private key entry').to.not.match(/qf1-priv-/)
              expect(sent, 'nothing writes decryptWith').to.not.match(/"decryptWith":"quonfig/)
              expect(qf1Writes.legacyWrites(), 'no per-family write route is used for a secret').to.deep.equal([])
              for (const push of qf1Writes.pushes()) expect(push.message).to.match(/^qfg: (create|set) secret /)
            }
          })
        }
      }
    })
  }
})
