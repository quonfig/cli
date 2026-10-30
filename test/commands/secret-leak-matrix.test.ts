import type {SetupServer} from 'msw/node'

import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server as createServer} from '../responses/create.js'
import {server as getServer} from '../responses/get.js'
import {confidentialOverridePlaintext, server as infoServer} from '../responses/info.js'
import {server as setDefaultServer} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

/**
 * Secret leak matrix (qfg-r3a47, from the qfg-38lp QA script).
 *
 * Every command that touches a secret or confidential value runs in each
 * output mode, and its stdout + stderr must never contain the plaintext. A
 * new command or output path that prints a value should get a row here.
 * `qfg get --reveal` is the one path meant to print plaintext and is left out;
 * `qfg history` renders server-side diffs and is covered by qfg-7usey.
 */

const ENCRYPTION_KEY = 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221'
const GET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const MODES: Array<{label: string; flags: string[]}> = [
  {flags: [], label: 'text'},
  {flags: ['--json'], label: '--json'},
  {flags: ['--verbose'], label: '--verbose'},
]

type Row = {argv: string[]; label: string; sentinels: string[]}

const GROUPS: Array<{env: Record<string, string>; name: string; rows: Row[]; server: SetupServer}> = [
  {
    env: {QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: ENCRYPTION_KEY},
    name: 'create',
    rows: [
      {
        argv: ['create', 'matrix.secret', '--type=string', '--secret', '--value=FAKE_MATRIX_CREATE_SECRET_01'],
        label: 'create --secret',
        sentinels: ['FAKE_MATRIX_CREATE_SECRET_01'],
      },
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
        label: 'set-default --secret',
        sentinels: ['FAKE_MATRIX_SD_SECRET_03'],
      },
      {
        argv: ['set-default', 'robocop-secret', '--environment=Staging', '--value=FAKE_MATRIX_SD_AUTO_04', '--confirm'],
        label: 'set-default on an encrypted key (auto-detected)',
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
        label: 'set-default on a key encrypted only per-environment (auto-detected)',
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
      before(() => group.server.listen())
      afterEach(() => {
        group.server.resetHandlers()
        resetClientCache()
      })
      after(() => group.server.close())

      for (const row of group.rows) {
        for (const mode of MODES) {
          test
            .env(group.env)
            .stdout()
            .stderr()
            .command([...row.argv, ...mode.flags])
            .it(`${row.label} [${mode.label}] prints no plaintext`, (ctx) => {
              const output = ctx.stdout + ctx.stderr
              expect(output, 'command printed nothing; is the fixture wired?').to.not.equal('')
              for (const sentinel of row.sentinels) expect(output).to.not.contain(sentinel)
            })
        }
      }
    })
  }
})
