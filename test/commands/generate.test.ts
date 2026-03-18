import {expect, test} from '@oclif/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/generate.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('generate', () => {
  const configPath = path.join(process.cwd(), 'quonfig.config.json')

  before(() => {
    setupTestAuth()
    server.listen()
  })

  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
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
    .command(['generate'])
    .it('runs generate without flags', (ctx) => {
      // Updated to match the new default behavior (react-ts is the default target)
      expect(ctx.stdout).to.include('Generating react-ts code for configs')
    })

  test
    .stdout()
    .command(['generate', '--targets', 'node-ts'])
    .it('generates TypeScript definitions', (ctx) => {
      expect(ctx.stdout).to.include('Generating node-ts code for configs')
    })

  test
    .stdout()
    .command(['generate', '--targets', 'react-ts'])
    .it('generates React TypeScript definitions', (ctx) => {
      expect(ctx.stdout).to.include('Generating react-ts code for configs')
    })

  test
    .stdout()
    .command(['generate', '--targets', 'invalid'])
    .catch((error) => {
      expect(error.message).to.include('Unsupported target: invalid')
    })
    .it('handles invalid targets', () => {
      // Error assertion done in catch block
    })

  describe('local configuration file parsing', () => {
    test
      .stderr()
      .stdout()
      .command(['generate', '--verbose', '--targets', 'node-ts'])
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
        // Create a valid config file
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
      .command(['generate', '--verbose', '--targets', 'node-ts,react-ts'])
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
        // Create config with only global outputDirectory
        const globalConfig = {
          outputDirectory: 'generated/global-output',
        }
        fs.writeFileSync(configPath, JSON.stringify(globalConfig, null, 2))
      })
      .command(['generate', '--verbose', '--targets', 'react-ts'])
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
        // Create config with partial target-specific config
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
      .command(['generate', '--verbose', '--targets', 'node-ts'])
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
        // Create config with empty targets object
        const emptyTargetsConfig = {
          outputDirectory: 'generated/base-output',
          targets: {},
        }
        fs.writeFileSync(configPath, JSON.stringify(emptyTargetsConfig, null, 2))
      })
      .command(['generate', '--verbose', '--targets', 'react-ts'])
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
      .command(['generate', '--targets', 'node-ts'])
      .catch((error) => {
        expect(error.message).to.include('Error reading quonfig.config.json')
      })
      .it('handles invalid JSON in config file', () => {
        // Error assertion done in catch block
      })

    test
      .do(() => {
        // Create config with invalid schema
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
      .command(['generate', '--targets', 'node-ts'])
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
        // Create minimal valid config
        const minimalConfig = {}
        fs.writeFileSync(configPath, JSON.stringify(minimalConfig, null, 2))
      })
      .command(['generate', '--verbose', '--targets', 'node-ts'])
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
        // Create config that overrides only clientFileName
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
      .command(['generate', '--verbose', '--targets', 'node-ts,react-ts'])
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
      .command(['generate', '--targets', 'node-ts'])
      .catch((error) => {
        expect(error.message).to.include('Error reading quonfig.config.json')
      })
      .it('handles case where config path is a directory', () => {
        // Error assertion done in catch block
      })
  })

  after(() => {
    server.close()
    cleanupTestAuth()
  })
})
