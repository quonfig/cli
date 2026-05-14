import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/workspace')
const configPath = path.join(process.cwd(), 'quonfig.config.json')

describe('generate', () => {
  afterEach(() => {
    try {
      // Clean up any test config files (could be file or directory)
      if (fs.existsSync(configPath)) {
        const stat = fs.statSync(configPath)
        if (stat.isDirectory()) {
          fs.rmSync(configPath, {force: true, recursive: true})
        } else {
          fs.unlinkSync(configPath)
        }
      }
    } catch {
      // Do nothing
    }
  })

  test
    .stdout()
    .command(['generate', '--dir', FIXTURE_DIR])
    .it('runs generate without explicit targets (defaults to react-ts)', (ctx) => {
      expect(ctx.stdout).to.include('Generating react-ts code for configs')
    })

  test
    .stdout()
    .command(['generate', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
    .it('generates node-ts TypeScript definitions', (ctx) => {
      expect(ctx.stdout).to.include('Generating node-ts code for configs')
    })

  test
    .stdout()
    .command(['generate', '--dir', FIXTURE_DIR, '--targets', 'react-ts'])
    .it('generates react-ts TypeScript definitions', (ctx) => {
      expect(ctx.stdout).to.include('Generating react-ts code for configs')
    })

  test
    .stdout()
    .command(['generate', '--dir', FIXTURE_DIR, '--targets', 'invalid'])
    .catch((error) => {
      expect(error.message).to.include('Unsupported target: invalid')
    })
    .it('handles invalid targets', () => {
      // Error assertion done in catch block
    })

  describe('without --dir flag (qfg-0mj)', () => {
    let originalApiKey: string | undefined
    let originalWorkspace: string | undefined
    let originalDir: string | undefined

    beforeEach(() => {
      originalApiKey = process.env.QUONFIG_API_KEY
      originalWorkspace = process.env.QUONFIG_WORKSPACE
      originalDir = process.env.QUONFIG_DIR
      // Force the API-key auth branch so the test never touches stored OAuth
      // tokens or the network. resolveWorkspaceUuid short-circuits with a
      // specific error when QUONFIG_API_KEY is set but QUONFIG_WORKSPACE is
      // not — that error is the proof that generate now goes through auth
      // resolution instead of bailing out with "No directory specified".
      process.env.QUONFIG_API_KEY = 'qf_uk_test_only_do_not_use'
      delete process.env.QUONFIG_WORKSPACE
      delete process.env.QUONFIG_DIR
    })

    afterEach(() => {
      if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
      else process.env.QUONFIG_API_KEY = originalApiKey
      if (originalWorkspace === undefined) delete process.env.QUONFIG_WORKSPACE
      else process.env.QUONFIG_WORKSPACE = originalWorkspace
      if (originalDir === undefined) delete process.env.QUONFIG_DIR
      else process.env.QUONFIG_DIR = originalDir
    })

    test
      .command(['generate'])
      .catch((error) => {
        // Specific mechanism: generate must invoke resolveWorkspaceUuid when
        // no dir is provided. With API key set + workspace unset, that helper
        // emits this specific error before any network/git call. If you delete
        // the fix and restore the early `No directory specified` bailout,
        // this assertion fails.
        expect(error.message).to.include('QUONFIG_WORKSPACE')
        expect(error.message).to.not.include('No directory specified')
      })
      .it('attempts workspace resolution instead of erroring early when no --dir', () => {
        // Error assertion done in catch block
      })
  })

  /**
   * qfg-kr7.11: confirm `qfg generate` routes through the shared
   * org/ws-aware resolver (not its own slug parser). The simplest proof
   * is that a bare-slug `--workspace` value in OAuth mode produces the
   * exact migration error string the resolver throws — if generate.ts
   * had its own inline parsing, it would either accept the bare slug or
   * emit a different message.
   */
  describe('routes --workspace through the kr7.5 resolver', () => {
    let originalApiKey: string | undefined
    let originalDir: string | undefined

    beforeEach(() => {
      originalApiKey = process.env.QUONFIG_API_KEY
      originalDir = process.env.QUONFIG_DIR
      delete process.env.QUONFIG_API_KEY
      delete process.env.QUONFIG_DIR
    })

    afterEach(() => {
      if (originalApiKey === undefined) delete process.env.QUONFIG_API_KEY
      else process.env.QUONFIG_API_KEY = originalApiKey
      if (originalDir === undefined) delete process.env.QUONFIG_DIR
      else process.env.QUONFIG_DIR = originalDir
    })

    test
      .command(['generate', '--workspace', 'just-bare-slug'])
      .catch((error: Error) => {
        // Specific mechanism: this is the resolver's BARE_SLUG_ENV_MIGRATION_MESSAGE.
        expect(error.message).to.include('org/workspace form')
        expect(error.message).to.include('acme/foo')
        expect(error.message).to.include('qfg login')
      })
      .it('rejects bare-slug --workspace with the kr7.5 migration error')
  })

  test
    .command(['generate', '--dir', '/nonexistent/path/to/nowhere'])
    .catch((error) => {
      expect(error.message).to.include('Directory not found')
      expect(error.message).to.include('qfg pull')
    })
    .it('errors when --dir points to a nonexistent directory', () => {
      // Error assertion done in catch block
    })

  test
    // os.tmpdir() instead of a hardcoded '/tmp' — '/tmp' does not exist on
    // Windows, so the reader would throw "Directory not found" first.
    .command(['generate', '--dir', os.tmpdir()])
    .catch((error) => {
      expect(error.message).to.include('does not look like a Quonfig workspace')
    })
    .it('errors when --dir points to a directory without quonfig.json', () => {
      // Error assertion done in catch block
    })

  describe('generated content assertions', () => {
    test
      .stdout()
      .stderr()
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'react-ts'])
      .it('react-ts output contains bool flag type', (ctx) => {
        // my.bool-flag is a FEATURE_FLAG so it always appears in react-ts output
        expect(ctx.stderr).to.include('Writing file:')
        // Check the file was written with the right flag type
        const clientFile = path.join(process.cwd(), 'generated', 'quonfig-client-types.d.ts')
        expect(fs.existsSync(clientFile)).to.be.true
        const content = fs.readFileSync(clientFile, 'utf8')
        expect(content).to.include('my.bool-flag')
        expect(content).to.include('boolean')
      })

    test
      .stdout()
      .stderr()
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'react-ts'])
      .it('react-ts output excludes sendToClientSdk:false configs', (_ctx) => {
        // my.string-config has sendToClientSdk: false, so it should NOT appear in react-ts output
        const clientFile = path.join(process.cwd(), 'generated', 'quonfig-client-types.d.ts')
        expect(fs.existsSync(clientFile)).to.be.true
        const content = fs.readFileSync(clientFile, 'utf8')
        expect(content).to.not.include('my.string-config')
      })

    test
      .stdout()
      .stderr()
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'react-ts'])
      .it('react-ts output includes sendToClientSdk:true int config', (_ctx) => {
        // my.int-config has sendToClientSdk: true, so it SHOULD appear in react-ts output
        const clientFile = path.join(process.cwd(), 'generated', 'quonfig-client-types.d.ts')
        expect(fs.existsSync(clientFile)).to.be.true
        const content = fs.readFileSync(clientFile, 'utf8')
        expect(content).to.include('my.int-config')
      })

    test
      .stdout()
      .stderr()
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .it('node-ts output contains all configs and flags', (_ctx) => {
        const serverFile = path.join(process.cwd(), 'generated', 'quonfig-server-types.d.ts')
        expect(fs.existsSync(serverFile)).to.be.true
        const content = fs.readFileSync(serverFile, 'utf8')
        // node-ts shows all configs regardless of sendToClientSdk
        expect(content).to.include('my.string-config')
        expect(content).to.include('my.bool-flag')
        expect(content).to.include('my.int-config')
      })
  })

  describe('local configuration file parsing', () => {
    test
      .stderr()
      .stdout()
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .it('uses default config when no local config file exists', (ctx) => {
        expect(ctx.stderr).to.include('No quonfig.config.json file found in current directory.')
        expect(ctx.stderr).to.include('Output directory for node-ts: generated')
        expect(ctx.stdout).to.include('Generating node-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'quonfig-server.ts')}`)
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'quonfig-server-types.d.ts')}`)
      })

    test
      .stdout()
      .stderr()
      .do(() => {
        const validConfig = {
          outputDirectory: 'generated/custom-output',
          targets: {
            'node-ts': {
              clientFileName: 'custom-server.ts',
              declarationFileName: 'custom-server-types.d.ts',
              outputDirectory: 'generated/server-types',
            },
          },
        }
        fs.writeFileSync(configPath, JSON.stringify(validConfig, null, 2))
      })
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'node-ts,react-ts'])
      .it('loads and uses valid local config file', (ctx) => {
        expect(ctx.stderr).to.include('Found local quonfig.config.json')
        expect(ctx.stderr).to.include('Output directory for node-ts: generated/server-types')
        expect(ctx.stdout).to.include('Generating node-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'server-types', 'custom-server.ts')}`)
        expect(ctx.stderr).to.include(
          `Writing file: ${path.join('generated', 'server-types', 'custom-server-types.d.ts')}`,
        )
        expect(ctx.stderr).to.include('Output directory for react-ts: generated/custom-output')
        expect(ctx.stdout).to.include('Generating react-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'custom-output', 'quonfig-client.ts')}`)
        expect(ctx.stderr).to.include(
          `Writing file: ${path.join('generated', 'custom-output', 'quonfig-client-types.d.ts')}`,
        )
      })

    test
      .stdout()
      .stderr()
      .do(() => {
        const globalConfig = {
          outputDirectory: 'generated/global-output',
        }
        fs.writeFileSync(configPath, JSON.stringify(globalConfig, null, 2))
      })
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'react-ts'])
      .it('falls back to global outputDirectory when target-specific not provided', (ctx) => {
        expect(ctx.stderr).to.include('Found local quonfig.config.json')
        expect(ctx.stderr).to.include('Output directory for react-ts: generated/global-output')
        expect(ctx.stdout).to.include('Generating react-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'global-output', 'quonfig-client.ts')}`)
        expect(ctx.stderr).to.include(
          `Writing file: ${path.join('generated', 'global-output', 'quonfig-client-types.d.ts')}`,
        )
      })

    test
      .stdout()
      .stderr()
      .do(() => {
        const partialConfig = {
          outputDirectory: 'generated/default-output',
          targets: {
            'node-ts': {
              clientFileName: 'custom-node.ts',
              // outputDirectory intentionally omitted
              // declarationFileName intentionally omitted
            },
          },
        }
        fs.writeFileSync(configPath, JSON.stringify(partialConfig, null, 2))
      })
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .it('uses global config as fallback for missing target-specific properties', (ctx) => {
        expect(ctx.stderr).to.include('Found local quonfig.config.json')
        expect(ctx.stderr).to.include('Output directory for node-ts: generated/default-output')
        expect(ctx.stdout).to.include('Generating node-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'default-output', 'custom-node.ts')}`)
        expect(ctx.stderr).to.include(
          `Writing file: ${path.join('generated', 'default-output', 'quonfig-server-types.d.ts')}`,
        )
      })

    test
      .stdout()
      .stderr()
      .do(() => {
        const emptyTargetsConfig = {
          outputDirectory: 'generated/base-output',
          targets: {},
        }
        fs.writeFileSync(configPath, JSON.stringify(emptyTargetsConfig, null, 2))
      })
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'react-ts'])
      .it('handles empty targets object', (ctx) => {
        expect(ctx.stderr).to.include('Found local quonfig.config.json')
        expect(ctx.stderr).to.include('Output directory for react-ts: generated/base-output')
        expect(ctx.stdout).to.include('Generating react-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'base-output', 'quonfig-client.ts')}`)
        expect(ctx.stderr).to.include(
          `Writing file: ${path.join('generated', 'base-output', 'quonfig-client-types.d.ts')}`,
        )
      })

    test
      .do(() => {
        // Create invalid JSON file
        fs.writeFileSync(configPath, '{ invalid json }')
      })
      .command(['generate', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .catch((error) => {
        expect(error.message).to.include('Error reading quonfig.config.json')
      })
      .it('handles invalid JSON in config file', () => {
        // Error assertion done in catch block
      })

    test
      .do(() => {
        const invalidConfig = {
          outputDirectory: 123, // should be string
          targets: {
            'invalid-target': {
              outputDirectory: 'test',
            },
          },
        }
        fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2))
      })
      .command(['generate', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .catch((error) => {
        expect(error.message).to.include('expected string, received number')
      })
      .it('validates config schema and rejects invalid types', () => {
        // Error assertion done in catch block
      })

    test
      .stdout()
      .stderr()
      .do(() => {
        const minimalConfig = {}
        fs.writeFileSync(configPath, JSON.stringify(minimalConfig, null, 2))
      })
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .it('handles minimal empty config object', (ctx) => {
        expect(ctx.stderr).to.include('Found local quonfig.config.json')
        expect(ctx.stderr).to.include('Output directory for node-ts: generated') // default
        expect(ctx.stdout).to.include('Generating node-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'quonfig-server.ts')}`)
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'quonfig-server-types.d.ts')}`)
      })

    test
      .stdout()
      .stderr()
      .do(() => {
        const filenameOnlyConfig = {
          targets: {
            'node-ts': {
              clientFileName: 'my-custom-server.ts',
              declarationFileName: 'my-custom-server-types.d.ts',
            },
            'react-ts': {
              clientFileName: 'my-custom-client.ts',
              declarationFileName: 'my-custom-client-types.d.ts',
            },
          },
        }
        fs.writeFileSync(configPath, JSON.stringify(filenameOnlyConfig, null, 2))
      })
      .command(['generate', '--verbose', '--dir', FIXTURE_DIR, '--targets', 'node-ts,react-ts'])
      .it('handles multiple targets with custom filenames', (ctx) => {
        expect(ctx.stderr).to.include('Found local quonfig.config.json')
        expect(ctx.stderr).to.include('Output directory for node-ts: generated') // default
        expect(ctx.stderr).to.include('Output directory for react-ts: generated') // default
        expect(ctx.stdout).to.include('Generating node-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'my-custom-server.ts')}`)
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'my-custom-server-types.d.ts')}`)
        expect(ctx.stdout).to.include('Generating react-ts code for configs')
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'my-custom-client.ts')}`)
        expect(ctx.stderr).to.include(`Writing file: ${path.join('generated', 'my-custom-client-types.d.ts')}`)
      })

    test
      .do(() => {
        // Create a directory instead of a file (edge case)
        fs.mkdirSync(configPath, {recursive: true})
      })
      .command(['generate', '--dir', FIXTURE_DIR, '--targets', 'node-ts'])
      .catch((error) => {
        expect(error.message).to.include('Error reading quonfig.config.json')
      })
      .it('handles case where config path is a directory', () => {
        // Error assertion done in catch block
      })
  })
})
