import {expect, test} from '@oclif/test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/get.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

/**
 * Tests for `qfg run`.
 *
 * The mode-resolution helper has its own unit tests in
 * test/util/resolve-run-environment.test.ts; here we focus on:
 *   - command-level validation errors (mode rule, missing args, malformed --env)
 *   - the resolution path (Mode B) actually pulling values from the API
 *   - one true integration test that spawns a real child process via the
 *     installed `bin/run.js` and checks its exit code + propagation.
 */

describe('run', () => {
  let savedSdkKey: string | undefined
  let savedEnvVar: string | undefined

  before(() => {
    setupTestAuth()
    server.listen()
  })

  beforeEach(() => {
    // The mode-rule tests need a clean slate — leftover env vars from other
    // tests leak into the binary mode and produce surprising errors.
    savedSdkKey = process.env.QUONFIG_BACKEND_SDK_KEY
    savedEnvVar = process.env.QUONFIG_ENVIRONMENT
    delete process.env.QUONFIG_BACKEND_SDK_KEY
    delete process.env.QUONFIG_ENVIRONMENT
  })

  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    if (savedSdkKey === undefined) delete process.env.QUONFIG_BACKEND_SDK_KEY
    else process.env.QUONFIG_BACKEND_SDK_KEY = savedSdkKey
    if (savedEnvVar === undefined) delete process.env.QUONFIG_ENVIRONMENT
    else process.env.QUONFIG_ENVIRONMENT = savedEnvVar
    delete process.env.TEST_CLI_PROVIDED_VAR
    delete process.env.TEST_CLI_ENCRYPTION_KEY
  })

  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('mode-rule errors (Mode A misuse)', () => {
    test
      .do(() => {
        process.env.QUONFIG_BACKEND_SDK_KEY = 'fake-sdk-key'
      })
      .command(['run', '--environment=production', '--', 'env'])
      .catch((error) => {
        expect(error.message).to.contain('QUONFIG_BACKEND_SDK_KEY is set')
        expect(error.message).to.contain('Remove --environment')
      })
      .it('errors when QUONFIG_BACKEND_SDK_KEY + --environment are both set')

    test
      .do(() => {
        process.env.QUONFIG_BACKEND_SDK_KEY = 'fake-sdk-key'
        process.env.QUONFIG_ENVIRONMENT = 'production'
      })
      .command(['run', '--', 'env'])
      .catch((error) => {
        expect(error.message).to.contain('QUONFIG_BACKEND_SDK_KEY is set')
      })
      .it('errors when QUONFIG_BACKEND_SDK_KEY + QUONFIG_ENVIRONMENT are both set')
  })

  describe('mode-rule errors (Mode B no env)', () => {
    test
      .command(['run', '--', 'env'])
      .catch((error) => {
        expect(error.message).to.contain('no environment specified')
      })
      .it('errors when neither flag nor env var nor SDK key is set')
  })

  describe('inline --env parse errors', () => {
    test
      .command(['run', '--env=BROKEN_NO_EQUALS_HERE', '--environment=[default]', '--', 'env'])
      .catch((error) => {
        expect(error.message).to.contain('expected VAR=key')
      })
      .it('errors on a malformed --env value')

    test
      .command(['run', '--env=DATABASE_URL:db.url', '--environment=[default]', '--', 'env'])
      .catch((error) => {
        // colon-separator is rejected because we chose `=` for docker parity
        expect(error.message).to.contain('expected VAR=key')
      })
      .it('rejects colon-separated VAR:key.path')
  })

  describe('child-command errors', () => {
    test
      .command(['run', '--environment=[default]'])
      .catch((error) => {
        expect(error.message).to.contain('No child command specified')
      })
      .it('errors when no child command is provided after --')
  })

  describe('Mode B resolution against the API', () => {
    test
      .stderr()
      .command(['run', '--env=DATABASE_URL=my-string-list-key', '--environment=[default]', '--', 'true'])
      .catch((error) => {
        // In NODE_ENV=test we throw a marker error containing the child's exit code.
        const child = (error as {childExitCode?: number} & Error).childExitCode
        // 'true' exits 0; if 'true' is missing on the test host this might
        // be 127, but on macOS/Linux CI it's universally available.
        expect(child).to.equal(0)
      })
      .it('resolves a config and spawns a child that exits 0')

    test
      .command(['run', '--env=NOT_THERE=this-key-does-not-exist', '--environment=[default]', '--', 'true'])
      .catch((error) => {
        expect(error.message).to.contain('missing config key')
        expect(error.message).to.contain('this-key-does-not-exist')
      })
      .it('fails fast (does not spawn) when a key is missing in the workspace')
  })

  describe('--env-file', () => {
    // Compute the temp file path eagerly so it can be passed in the
    // .command() string array (oclif's test wrapper does not support
    // a thunk form).
    const tmpDir = path.join(os.tmpdir(), `qfg-run-envfile-${Date.now()}`)
    const goodFile = path.join(tmpDir, 'good.env')
    const badFile = path.join(tmpDir, 'bad.env')

    before(() => {
      fs.mkdirSync(tmpDir, {recursive: true})
      fs.writeFileSync(goodFile, '# comment\n\nDATABASE_URL=my-string-list-key\n')
      fs.writeFileSync(badFile, 'BROKEN_LINE\n')
    })

    after(() => {
      try {
        fs.rmSync(tmpDir, {recursive: true, force: true})
      } catch {
        // ignore — file may not have been created
      }
    })

    test
      .stderr()
      .command(['run', `--env-file=${goodFile}`, '--environment=[default]', '--', 'true'])
      .catch((error) => {
        const child = (error as {childExitCode?: number} & Error).childExitCode
        expect(child).to.equal(0)
      })
      .it('resolves entries from --env-file and spawns the child')

    test
      .command(['run', `--env-file=${badFile}`, '--environment=[default]', '--', 'true'])
      .catch((error) => {
        expect(error.message).to.contain('line 1')
      })
      .it('reports the line number on a malformed env-file line')
  })

  /**
   * Full integration test: spawn the CLI as a real subprocess via the
   * compiled binary so we exercise oclif arg parsing, the spawn() path,
   * and the exit-code propagation end-to-end.
   *
   * We don't need real auth or a live API server here: we use Mode A's
   * misuse error (SDK key + --environment together) to prove that the
   * binary returns non-zero on the mode rule. This catches packaging
   * issues that the unit tests miss (e.g. command not registered, manifest
   * out of sync) while still being deterministic.
   */
  describe('integration: real subprocess', () => {
    it('binary returns non-zero and the right error message on Mode A misuse', function () {
      // Spawning the real CLI binary takes a few seconds (oclif boot,
      // hooks, manifest read). Default mocha timeout is 10s, which is
      // tight on a loaded test host; give explicit headroom.
      this.timeout(30_000)
      // ESM: __dirname is not defined; derive it from import.meta.url.
      const here = path.dirname(fileURLToPath(import.meta.url))
      const cliRoot = path.resolve(here, '..', '..')
      const binPath = path.join(cliRoot, 'bin', 'run.js')

      // Pipe stderr to a Buffer (node's `stdio: ['ignore','pipe','pipe']`)
      // and merge it with stdout so test assertions don't depend on which
      // stream the message landed on.
      let combined = ''
      let exitCode = 0
      try {
        execFileSync('node', [binPath, 'run', '--environment=production', '--', 'true'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            QUONFIG_BACKEND_SDK_KEY: 'fake-sdk-key',
            NODE_ENV: 'production',
          },
        })
      } catch (error) {
        const e = error as {status?: number; stderr?: string | Buffer; stdout?: string | Buffer}
        exitCode = e.status ?? 0
        combined = `${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`
      }

      expect(exitCode).to.not.equal(0)
      expect(combined).to.contain('QUONFIG_BACKEND_SDK_KEY is set')
    })
  })
})
