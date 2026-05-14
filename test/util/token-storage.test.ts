import {expect} from '@oclif/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, it} from 'mocha'

import {
  type AuthConfig,
  getActiveProfile,
  getAuthConfigFilePath,
  getTokenFilePath,
  getTokenForOrg,
  loadAuthConfig,
  loadTokens,
  saveAuthConfig,
  saveTokens,
  type TokenSet,
  type TokenStorageOptions,
  type TokenStore,
} from '../../src/util/token-storage.js'

describe('token-storage', () => {
  const testDir = path.join(os.tmpdir(), '.quonfig-test-' + Date.now())
  const quonfigDir = path.join(testDir, '.quonfig')
  const options: TokenStorageOptions = {quonfigDir}
  // The on-disk filenames are domain-suffixed (see token-storage.ts) when
  // QUONFIG_DOMAIN is set — which it is in CI. Resolve the real paths via the
  // same helpers the CLI uses instead of hardcoding `config` / `tokens.json`.
  // These are resolved at call time (not module load) because the
  // `domain-scoped file paths` test mutates QUONFIG_DOMAIN mid-run.
  const configFile = () => getAuthConfigFilePath(options)
  const tokenFile = () => getTokenFilePath(options)

  beforeEach(() => {
    // Create test directory and .quonfig subdirectory
    fs.mkdirSync(quonfigDir, {recursive: true})
  })

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true})
    }

    // Clean up env vars
    delete process.env.QUONFIG_PROFILE
  })

  describe('saveAuthConfig', () => {
    it('should save a single profile with comment', async () => {
      const config: AuthConfig = {
        defaultProfile: 'default',
        profiles: {
          default: {
            workspace: 'workspace-123',
            workspaceName: 'Org Name - Workspace Name',
          },
        },
      }

      await saveAuthConfig(config, options)

      const content = fs.readFileSync(configFile(), 'utf8')
      expect(content).to.include('default_profile = default')
      expect(content).to.include('[profile default]')
      expect(content).to.include('workspace = workspace-123 # Org Name - Workspace Name')
    })

    it('should save multiple profiles', async () => {
      const config: AuthConfig = {
        defaultProfile: 'work',
        profiles: {
          default: {
            workspace: 'workspace-default',
            workspaceName: 'Default Org - Default Workspace',
          },
          work: {
            workspace: 'workspace-work',
            workspaceName: 'Work Org - Work Workspace',
          },
        },
      }

      await saveAuthConfig(config, options)

      const content = fs.readFileSync(configFile(), 'utf8')
      expect(content).to.include('default_profile = work')
      expect(content).to.include('[profile default]')
      expect(content).to.include('[profile work]')
      expect(content).to.include('workspace = workspace-default # Default Org - Default Workspace')
      expect(content).to.include('workspace = workspace-work # Work Org - Work Workspace')
    })
  })

  describe('loadAuthConfig', () => {
    it('should load a single profile', async () => {
      const configContent = `default_profile = default

[profile default]
workspace = workspace-123 # Org Name - Workspace Name

`
      fs.writeFileSync(configFile(), configContent, 'utf8')

      const config = await loadAuthConfig(options)

      expect(config).to.not.be.null
      expect(config!.defaultProfile).to.equal('default')
      expect(config!.profiles.default.workspace).to.equal('workspace-123')
      expect(config!.profiles.default.workspaceName).to.equal('Org Name - Workspace Name')
    })

    it('should load multiple profiles', async () => {
      const configContent = `default_profile = work

[profile default]
workspace = workspace-default # Default Org - Default Workspace

[profile work]
workspace = workspace-work # Work Org - Work Workspace

`
      fs.writeFileSync(configFile(), configContent, 'utf8')

      const config = await loadAuthConfig(options)

      expect(config).to.not.be.null
      expect(config!.defaultProfile).to.equal('work')
      expect(config!.profiles.default.workspace).to.equal('workspace-default')
      expect(config!.profiles.work.workspace).to.equal('workspace-work')
      expect(config!.profiles.default.workspaceName).to.equal('Default Org - Default Workspace')
      expect(config!.profiles.work.workspaceName).to.equal('Work Org - Work Workspace')
    })

    it('should return null for missing file', async () => {
      // Ensure config file doesn't exist
      if (fs.existsSync(configFile())) {
        fs.unlinkSync(configFile())
      }

      const config = await loadAuthConfig(options)
      expect(config).to.be.null
    })
  })

  describe('domain-scoped file paths', () => {
    afterEach(() => {
      delete process.env.QUONFIG_DOMAIN
    })

    it('writes config to config-<domain> and isolates staging from prod', async () => {
      const stagingConfig: AuthConfig = {
        defaultProfile: 'default',
        profiles: {
          default: {workspace: 'staging-ws', workspaceSlug: 'lt-1'},
        },
      }
      const prodConfig: AuthConfig = {
        defaultProfile: 'default',
        profiles: {
          default: {workspace: 'prod-ws', workspaceSlug: 'prod-slug'},
        },
      }

      // The prod (quonfig.com) config filename is plain `config`; staging is
      // `config-quonfig-staging-com`. This test asserts they're independent,
      // so resolve the prod path with QUONFIG_DOMAIN explicitly cleared.
      const prodConfigFile = path.join(quonfigDir, 'config')

      process.env.QUONFIG_DOMAIN = 'quonfig-staging.com'
      await saveAuthConfig(stagingConfig, options)
      expect(fs.existsSync(path.join(quonfigDir, 'config-quonfig-staging-com'))).to.equal(true)
      expect(fs.existsSync(prodConfigFile), 'prod config file should not be touched').to.equal(false)

      delete process.env.QUONFIG_DOMAIN
      await saveAuthConfig(prodConfig, options)
      expect(fs.existsSync(prodConfigFile)).to.equal(true)

      // Read each domain back and confirm they are independent
      const prodLoaded = await loadAuthConfig(options)
      expect(prodLoaded?.profiles.default.workspace).to.equal('prod-ws')

      process.env.QUONFIG_DOMAIN = 'quonfig-staging.com'
      const stagingLoaded = await loadAuthConfig(options)
      expect(stagingLoaded?.profiles.default.workspace).to.equal('staging-ws')
    })
  })

  describe('post-write verification', () => {
    const sampleTokenSet: TokenSet = {
      access_token: 'access',
      expires_at: Date.now() + 60_000,
      refresh_token: 'refresh',
      user_email: 'a@b.com',
      user_id: 'u1',
    }
    const sampleTokens: TokenStore = {
      defaultOrgId: 'org_1',
      tokensByOrg: {org_1: sampleTokenSet},
    }

    it('saveTokens throws if the target file is missing after rename', async () => {
      const originalRename = fs.promises.rename
      // Simulate a wedged/clobbered rename: the call returns success but the
      // target file never appears on disk (e.g. concurrent npm install -g).
      ;(fs.promises as unknown as {rename: typeof fs.promises.rename}).rename = (async (src: fs.PathLike) => {
        // Clean up the tmp file but leave the target absent.
        try {
          await originalRename.call(fs.promises, src, src)
          await fs.promises.unlink(src)
        } catch {
          // ignore
        }
      }) as typeof fs.promises.rename

      try {
        let caught: Error | undefined
        try {
          await saveTokens(sampleTokens, options)
        } catch (error) {
          caught = error as Error
        }

        expect(caught, 'expected saveTokens to throw when target file is missing').to.exist
        expect(caught!.message).to.match(/token|verif|persist/i)
      } finally {
        ;(fs.promises as unknown as {rename: typeof fs.promises.rename}).rename = originalRename
      }
    })

    it('saveAuthConfig throws if the target file is missing after rename', async () => {
      const config: AuthConfig = {
        defaultProfile: 'default',
        profiles: {default: {workspace: 'ws-1'}},
      }

      const originalRename = fs.promises.rename
      ;(fs.promises as unknown as {rename: typeof fs.promises.rename}).rename = (async (src: fs.PathLike) => {
        try {
          await originalRename.call(fs.promises, src, src)
          await fs.promises.unlink(src)
        } catch {
          // ignore
        }
      }) as typeof fs.promises.rename

      try {
        let caught: Error | undefined
        try {
          await saveAuthConfig(config, options)
        } catch (error) {
          caught = error as Error
        }

        expect(caught, 'expected saveAuthConfig to throw when target file is missing').to.exist
        expect(caught!.message).to.match(/config|verif|persist/i)
      } finally {
        ;(fs.promises as unknown as {rename: typeof fs.promises.rename}).rename = originalRename
      }
    })

    it('saveTokens succeeds and the file round-trips on a normal write', async () => {
      await saveTokens(sampleTokens, options)
      // Round-trip via the existing loader path
      const content = fs.readFileSync(tokenFile(), 'utf8')
      const parsed = JSON.parse(content) as TokenStore
      expect(parsed.tokensByOrg.org_1.access_token).to.equal('access')
    })
  })

  describe('per-org token storage', () => {
    const orgA: TokenSet = {access_token: 'a-tok', expires_at: 1, refresh_token: 'a-ref'}
    const orgB: TokenSet = {access_token: 'b-tok', expires_at: 2, refresh_token: 'b-ref'}

    it('saveTokens writes the new tokensByOrg shape', async () => {
      const store: TokenStore = {
        defaultOrgId: 'org_A',
        tokensByOrg: {org_A: orgA, org_B: orgB},
      }
      await saveTokens(store, options)

      const onDisk = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as TokenStore
      expect(onDisk.tokensByOrg.org_A.access_token).to.equal('a-tok')
      expect(onDisk.tokensByOrg.org_B.refresh_token).to.equal('b-ref')
      expect(onDisk.defaultOrgId).to.equal('org_A')
    })

    it('loadTokens round-trips the new shape', async () => {
      const store: TokenStore = {tokensByOrg: {org_A: orgA}}
      await saveTokens(store, options)
      const loaded = await loadTokens(options)
      // saveTokens stamps the schema version (qfg-7mau); compare other fields directly.
      expect(loaded?.tokensByOrg).to.deep.equal(store.tokensByOrg)
      expect(loaded?.version).to.be.a('number')
    })

    it('loadTokens returns null when the file does not exist', async () => {
      const loaded = await loadTokens(options)
      expect(loaded).to.equal(null)
    })

    it('loadTokens rejects a malformed file', async () => {
      fs.writeFileSync(tokenFile(), JSON.stringify({nonsense: true}), 'utf8')

      let caught: Error | undefined
      try {
        await loadTokens(options)
      } catch (error) {
        caught = error as Error
      }

      expect(caught).to.exist
      expect(caught!.message).to.include('qfg login')
    })

    it('loadTokens rejects a file written by a newer CLI version', async () => {
      fs.writeFileSync(tokenFile(), JSON.stringify({version: 99, tokensByOrg: {org_A: orgA}}), 'utf8')

      let caught: Error | undefined
      try {
        await loadTokens(options)
      } catch (error) {
        caught = error as Error
      }

      expect(caught).to.exist
      expect(caught!.message).to.match(/newer cli/i)
      expect(caught!.message).to.include('npm i -g @quonfig/cli@latest')
    })

    it('saveTokens stamps a version field on the file', async () => {
      const store: TokenStore = {tokensByOrg: {org_A: orgA}}
      await saveTokens(store, options)
      const onDisk = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as {version?: number} & TokenStore
      expect(onDisk.version).to.equal(2)
    })

    it('getTokenForOrg returns the matching token set', () => {
      const store: TokenStore = {tokensByOrg: {org_A: orgA, org_B: orgB}}
      expect(getTokenForOrg(store, 'org_A')).to.deep.equal(orgA)
      expect(getTokenForOrg(store, 'org_B')).to.deep.equal(orgB)
    })

    it('getTokenForOrg returns undefined for a missing org', () => {
      const store: TokenStore = {tokensByOrg: {org_A: orgA}}
      expect(getTokenForOrg(store, 'org_missing')).to.equal(undefined)
    })
  })

  describe('getActiveProfile', () => {
    it('should return provided argument first', () => {
      process.env.QUONFIG_PROFILE = 'env-profile'
      expect(getActiveProfile('arg-profile')).to.equal('arg-profile')
    })

    it('should return env var if no argument', () => {
      process.env.QUONFIG_PROFILE = 'env-profile'
      expect(getActiveProfile()).to.equal('env-profile')
    })

    it('should return "default" if no argument or env var', () => {
      expect(getActiveProfile()).to.equal('default')
    })

    it('should prioritize: arg > env > default', () => {
      // No arg, no env
      expect(getActiveProfile()).to.equal('default')

      // Env set
      process.env.QUONFIG_PROFILE = 'env-profile'
      expect(getActiveProfile()).to.equal('env-profile')

      // Arg overrides env
      expect(getActiveProfile('arg-profile')).to.equal('arg-profile')
    })
  })
})
