/**
 * Fix round of the PR 3b validation (bead qfg-mol-hle): behaviours of the
 * secret write commands that no test pinned before, plus the fixes S1, S3,
 * S6 and N1 to N7. Runs the built command (dist) against the fake server of
 * secret-write-fixtures.ts and a real file:// workspace repo.
 */
import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {decrypt} from '../../src/secrets/qf1.js'
import {resetClientCache} from '../../src/util/get-client.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'
import {
  ONE_KEYSET,
  TWO_KEYSETS,
  WORKSPACE_B,
  allRequestText,
  fakeTty,
  flat,
  keys,
  oldFormatConfig,
  pushes,
  removeWorkspaces,
  resetState,
  restoreStdin,
  restoreTty,
  server,
  setStdin,
  setStdinBytes,
  state,
  storedSecret,
  workspace,
} from './secret-write-fixtures.js'

const PLAINTEXT = 'FAKE_FIX_ROUND_secret_value_0099'
const BOM = String.fromCodePoint(0xfe_ff)
const oldFormat = (key: string) =>
  `${key} holds old-format encrypted values, which this version of qfg cannot change. ` +
  '`qfg secret migrate` (in a later release) will move them to secrets/; until then, change the value with ' +
  'qfg 0.13.0 or earlier (npm install -g @quonfig/cli@0.13.0).'

const listedSecret = (files: Record<string, string> = {}) => {
  resetState()
  workspace({'quonfig.json': TWO_KEYSETS, 'secrets/db.password.json': storedSecret('db.password'), ...files})
  state.listed = [{key: 'db.password', type: 'secret', valueType: 'string'}]
}

const unlistedSecret = () => {
  listedSecret()
  state.listed = []
}

const twin = () => {
  listedSecret({'configs/db.password.json': JSON.stringify(oldFormatConfig('db.password'))})
  state.listed = [{key: 'db.password', type: 'config', valueType: 'string'}]
  state.documents = {'db.password': oldFormatConfig('db.password')}
}

/** Make removing a snapshot directory fail, as a locked temp dir on Windows would (validator rmfail.cjs). */
const originalRm = fs.promises.rm
const failSnapshotCleanup = () => {
  fs.promises.rm = (async (p: fs.PathLike, ...rest: unknown[]) => {
    if (path.basename(String(p)).startsWith('qfg-secret-snapshot-')) {
      const error = new Error(`EPERM: operation not permitted, rmdir '${String(p)}'`) as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }

    return (originalRm as (...a: unknown[]) => Promise<void>)(p, ...rest)
  }) as typeof fs.promises.rm
}

const restoreRm = () => {
  fs.promises.rm = originalRm
}

/** Commands run from dist, which keeps its own client cache (workspace id): reset that one too. */
const resetDistClient = async () => {
  const dist = '../../dist/util/get-client.js'
  ;((await import(dist)) as {resetClientCache: () => void}).resetClientCache()
}

describe('secret write commands: fix round (qfg-mol-hle PR 3b)', function () {
  this.timeout(30_000)
  before(() => {
    setupTestAuth()
    server.listen({onUnhandledRequest: 'error'})
  })
  beforeEach(() => listedSecret())
  afterEach(async () => {
    expect(allRequestText(), 'no request may carry the plaintext').to.not.include(PLAINTEXT)
    server.resetHandlers()
    resetClientCache()
    await resetDistClient()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
    removeWorkspaces()
  })

  describe('S1: a cleanup error after a successful push does not fail the command', () => {
    for (const json of [false, true]) {
      test
        .do(() => {
          resetState()
          workspace({'quonfig.json': ONE_KEYSET})
          failSnapshotCleanup()
        })
        .finally(restoreRm)
        .stdout()
        .stderr()
        .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`, ...(json ? ['--json'] : [])])
        .it(`create --secret${json ? ' --json' : ''}`, (ctx) => {
          expect(pushes()).to.have.length(1)
          if (json) expect(JSON.parse(ctx.stdout).commitSha).to.equal('c'.repeat(40))
          else expect(ctx.stdout).to.include('Created secret: stripe.key')
          expect(ctx.stderr).to.not.include('EPERM')
        })

      test
        .do(failSnapshotCleanup)
        .finally(restoreRm)
        .stdout()
        .stderr()
        .command([
          'set-default',
          'db.password',
          '--environment=production',
          `--value=${PLAINTEXT}`,
          '--confirm',
          ...(json ? ['--json'] : []),
        ])
        .it(`set-default on a secret${json ? ' --json' : ''}`, (ctx) => {
          expect(pushes()).to.have.length(1)
          if (json) expect(JSON.parse(ctx.stdout).commitSha).to.equal('c'.repeat(40))
          else expect(ctx.stdout).to.include('Set production fallback to')
          expect(ctx.stderr).to.not.include('EPERM')
        })
    }

    test
      .do(failSnapshotCleanup)
      .finally(restoreRm)
      .stdout()
      .stderr()
      .command([
        'set-default',
        'db.password',
        '--environment=production',
        `--value=${PLAINTEXT}`,
        '--confirm',
        '--verbose',
      ])
      .it('--verbose logs the cleanup error', (ctx) => {
        expect(ctx.stderr).to.include('EPERM')
      })
  })

  describe('S3: non-UTF-8 input is refused for a secret, never replaced', () => {
    test
      .do(() => {
        resetState()
        workspace({'quonfig.json': ONE_KEYSET})
        setStdinBytes(Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0xfe, 0x2d, 0x75, 0x74, 0x66]))
      })
      .finally(restoreStdin)
      .stdout()
      .stderr()
      .command(['create', 'stripe.key', '--secret', '--value-stdin'])
      .catch((error) => {
        expect(error.message).to.equal(
          '--value-stdin: the input is not valid UTF-8. A secret is stored exactly as given, so nothing was written; convert the input to UTF-8 first.',
        )
        expect(pushes()).to.deep.equal([])
      })
      .it('create --secret --value-stdin with invalid UTF-8')

    test
      .do(() => setStdinBytes(Buffer.from([0xc3, 0x28])))
      .finally(restoreStdin)
      .stdout()
      .stderr()
      .command(['set-default', 'db.password', '--environment=production', '--value-stdin', '--confirm'])
      .catch((error) => {
        expect(error.message).to.match(/^--value-stdin: the input is not valid UTF-8/)
        expect(pushes()).to.deep.equal([])
      })
      .it('set-default on a secret with invalid UTF-8')

    test
      .do(() => {
        resetState()
        workspace({'quonfig.json': ONE_KEYSET})
        setStdin(`${BOM}${PLAINTEXT}\n`)
      })
      .finally(restoreStdin)
      .stdout()
      .stderr()
      .command(['create', 'stripe.key', '--secret', '--value-stdin'])
      .it('a leading BOM is kept, byte for byte', () => {
        const value = JSON.parse(pushes()[0].files[0].afterJson).default.rules[0].value.value
        expect(decrypt(value, {QUONFIG_KEYSET: keys.main.privateEntry})).to.equal(`${BOM}${PLAINTEXT}`)
      })
  })

  describe('S5(a): change-request and env-var flags are refused on every kind of secret', () => {
    for (const [label, setup] of [
      ['a secret the server does not list', unlistedSecret],
      ['a key in both configs/ (old format) and secrets/', twin],
    ] as const) {
      for (const [argv, message] of [
        [['--propose', `--value=${PLAINTEXT}`], /^Change requests cannot carry secrets yet/],
        [['--cr=3', `--value=${PLAINTEXT}`], /^Change requests cannot carry secrets yet/],
        [['--env-var=SOME_VAR'], /^secrets hold an encrypted value; --env-var does not apply/],
        [['--no-confidential', `--value=${PLAINTEXT}`], /^secrets are always confidential/],
      ] as const) {
        test
          .do(setup)
          .stdout()
          .stderr()
          .command(['set-default', 'db.password', '--environment=production', '--confirm', ...argv])
          .catch((error) => {
            expect(error.message).to.match(message)
            expect(pushes()).to.deep.equal([])
            expect(state.requests.filter((r) => /changeRequests/.test(r.url))).to.deep.equal([])
          })
          .it(`${argv[0]} on ${label}`)
      }
    }
  })

  test
    .stdout()
    .stderr()
    .command(['set-default', 'db.password', '--environment=production', '--confirm', '--no-interactive'])
    .catch((error) => {
      expect(error.message).to.equal('Value is required')
      expect(pushes()).to.deep.equal([])
    })
    .it('S5(b): a non-interactive set-default on a secret without a value is refused')

  describe('S5(c, d) and N7: what the confirm prompt says, and refusals before any prompt', () => {
    test
      .do(() => fakeTty('n\r'))
      .finally(restoreTty)
      .stdout()
      .stderr()
      .command([
        'set-default',
        'db.password',
        '--environment=production',
        '--keyset',
        'QUONFIG_KEYSET',
        `--value=${PLAINTEXT}`,
      ])
      .it('the move notice is in the confirm prompt; answering no writes nothing', (ctx) => {
        expect(flat(ctx.stdout)).to.include(
          'Moving db.password (production) from QUONFIG_KEYSET_PROD to QUONFIG_KEYSET: runtimes that hold only QUONFIG_KEYSET_PROD will fail to read it. (y/N)',
        )
        expect(pushes()).to.deep.equal([])
      })

    test
      .do(() => fakeTty('n\r'))
      .finally(restoreTty)
      .stdout()
      .stderr()
      .command([
        'set-default',
        'db.password',
        '--environment=production',
        '--replace-targeting',
        `--value=${PLAINTEXT}`,
      ])
      .it('the replace-targeting prompt says how many targeting rules it deletes', (ctx) => {
        expect(flat(ctx.stdout)).to.match(
          /Confirm: set db\.password in production to \[encrypted .*] on QUONFIG_KEYSET_PROD \(key [\da-f]{8}\) for EVERYONE, deleting 1 targeting rule\?/,
        )
      })

    test
      .do(() => {
        listedSecret({'secrets/db.password.json': storedSecret('db.password', {defaultTargeting: true})})
      })
      .stdout()
      .stderr()
      .command([
        'set-default',
        'db.password',
        '--environment=staging',
        '--replace-targeting',
        `--value=${PLAINTEXT}`,
        '--confirm',
        '--json',
      ])
      .it('a replace into a scope seeded from default deletes nothing of its own (count 0)', (ctx) => {
        const out = JSON.parse(ctx.stdout)
        expect(out).to.not.have.property('replacedTargetingRuleCount')
        expect(out.previousCommitSha).to.match(/^[\da-f]{40}$/)
      })

    test
      .do(() => fakeTty(''))
      .finally(restoreTty)
      .stdout()
      .stderr()
      .command(['set-default', 'db.password', '--keyset', 'QUONFIG_KEYSET_NOPE'])
      .catch((error) => {
        expect(error.message).to.equal(
          'Failed to change default: QUONFIG_KEYSET_NOPE is not a keyset in this workspace; declared: QUONFIG_KEYSET, QUONFIG_KEYSET_PROD',
        )
      })
      .it('an unknown --keyset is refused before asking for the environment or the value', (ctx) => {
        expect(ctx.stdout).to.not.match(/Which environment|Secret value/)
      })
  })

  test
    .do(() => {
      resetState()
      workspace({'configs/plain.config.json': '{}', 'quonfig.json': TWO_KEYSETS})
      state.listed = [{key: 'plain.config', type: 'config', valueType: 'string'}]
      state.documents = {
        'plain.config': {
          commitSha: 'a'.repeat(40),
          default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'p'}}]},
          environments: [],
          key: 'plain.config',
          type: 'config',
          valueType: 'string',
        },
      }
    })
    .stdout()
    .stderr()
    .command([
      'set-default',
      'plain.config',
      '--environment=production',
      '--keyset',
      'QUONFIG_KEYSET',
      '--value=x',
      '--confirm',
    ])
    .catch((error) => expect(error.message).to.equal('--keyset applies only to secrets'))
    .it('S5(e): --keyset on a non-secret is refused')

  describe('S5(f): --workspace decides which workspace is snapshotted and written', () => {
    test
      .do(() => {
        resetState()
        workspace({'quonfig.json': ONE_KEYSET})
      })
      .stdout()
      .stderr()
      .do(resetDistClient)
      .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`, '--workspace', 'test-organization/ws-b'])
      .it('create --secret --workspace B mints, reads and writes B only', () => {
        const bodies = state.requests
          .filter((r) => /gitea\/token|configs\/push|getDefaultCreateAccess/.test(r.url))
          .map((r) => r.body.json.workspaceId)
        expect(bodies).to.have.length(3)
        expect(
          bodies.every((id) => id === WORKSPACE_B),
          JSON.stringify(bodies),
        ).to.equal(true)
      })
  })

  describe('S5(g): set-default warns about --value and about a keyset this machine cannot read', () => {
    test
      .env({QUONFIG_KEYSET_PROD: undefined})
      .stdout()
      .stderr()
      .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
      .it('both notices on stderr', (ctx) => {
        expect(ctx.stderr).to.include(
          'Warning: --value puts the secret in argv and shell history; prefer --value-stdin or --value-from-env.',
        )
        expect(ctx.stderr).to.include(
          'This machine cannot read QUONFIG_KEYSET_PROD values (no QUONFIG_KEYSET_PROD here). That is expected: writing needs no private key.',
        )
      })
  })

  test
    .do(() => {
      resetState()
      workspace({'quonfig.json': ONE_KEYSET})
    })
    .stdout()
    .stderr()
    .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`, '--json'])
    .it('S5(h): create --secret --json has exactly the documented members', (ctx) => {
      const out = JSON.parse(ctx.stdout)
      expect(Object.keys(out).sort()).to.deep.equal([
        'commitSha',
        'firstSecretInWorkspace',
        'key',
        'keysetSource',
        'path',
        'scope',
        'value',
      ])
      expect(Object.keys(out.value).sort()).to.deep.equal([
        'encrypted',
        'fingerprint',
        'keyFingerprint',
        'keyset',
        'last4',
        'length',
        'redacted',
      ])
    })

  describe('S5(i), N4: every secret write is mirrored to QUONFIG_DIR', () => {
    let dir: string
    const mirrorDir = () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-mirror-'))
      fs.writeFileSync(path.join(dir, 'quonfig.json'), '{}')
      return dir
    }

    afterEach(() => fs.rmSync(dir, {force: true, recursive: true}))

    test
      .do(() => {
        resetState()
        workspace({'quonfig.json': ONE_KEYSET})
        process.env.QUONFIG_DIR = mirrorDir()
      })
      .finally(() => delete process.env.QUONFIG_DIR)
      .stdout()
      .stderr()
      .command([
        'create',
        'stripe.key',
        '--secret',
        `--value=${PLAINTEXT}`,
        '--workspace',
        'test-organization/test-workspace',
      ])
      .it('create', () => {
        const written = fs.readFileSync(path.join(dir, 'secrets', 'stripe.key.json'), 'utf8')
        expect(JSON.parse(written)).to.deep.equal(JSON.parse(pushes()[0].files[0].afterJson))
      })

    test
      .do(() => {
        process.env.QUONFIG_DIR = mirrorDir()
      })
      .finally(() => delete process.env.QUONFIG_DIR)
      .stdout()
      .stderr()
      .command([
        'set-default',
        'db.password',
        '--environment=production',
        `--value=${PLAINTEXT}`,
        '--confirm',
        '--workspace',
        'test-organization/test-workspace',
      ])
      .it('set-default', () => {
        const written = fs.readFileSync(path.join(dir, 'secrets', 'db.password.json'), 'utf8')
        expect(JSON.parse(written)).to.deep.equal(JSON.parse(pushes()[0].files[0].afterJson))
      })
  })

  describe('S6: the old-format refusal says what to do now', () => {
    test
      .do(twin)
      .do(() => {
        workspace({
          'configs/db.password.json': JSON.stringify(oldFormatConfig('db.password')),
          'quonfig.json': TWO_KEYSETS,
        })
      })
      .stdout()
      .stderr()
      .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
      .catch((error) => expect(error.message).to.equal(oldFormat('db.password')))
      .it('names the newest release with the old write path and qfg secret migrate')
  })

  describe('N1 to N3', () => {
    test
      .do(() => {
        resetState()
        workspace({'quonfig.json': ONE_KEYSET})
      })
      .stdout()
      .stderr()
      .command(['create', 'plain.key', '--type=string', '--value=x', '--secret-key-name=y'])
      .catch(() => {})
      .it('N1: the --secret-key-name note is printed once', (ctx) => {
        expect(ctx.stderr.split('--secret-key-name no longer applies')).to.have.length(2)
        // and no other warning about the flag (oclif's `deprecated` printed one per parse)
        expect(ctx.stderr).to.not.match(/deprecated/i)
      })

    test
      .do(() => {
        resetState()
        workspace({'quonfig.json': '{"workspace": "SENTINEL-CONTENT", oops'})
      })
      .stdout()
      .stderr()
      .command(['create', 'stripe.key', '--secret', `--value=${PLAINTEXT}`])
      .catch((error) => {
        expect(error.message).to.include('quonfig.json is not valid JSON')
        expect(error.message).to.not.include('SENTINEL-CONTENT')
      })
      .it('N2: an unparseable quonfig.json is reported as such, without its content')

    test
      .do(() => {
        unlistedSecret()
        state.tokenStatus = 500
      })
      .stdout()
      .stderr()
      .command(['set-default', 'db.password', '--environment=production', `--value=${PLAINTEXT}`, '--confirm'])
      .catch((error) => {
        expect(error.message).to.equal(
          'Could not find config named db.password (secrets/ could not be checked: qfg could not read the workspace repo)',
        )
        expect(error.message).to.not.match(/token|https?:/)
      })
      .it('N3: when the secrets/ lookup cannot run, the not-found message says so')
  })
})
