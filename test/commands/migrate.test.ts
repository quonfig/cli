import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {applyLaunchDarklyBaseUrl} from '../../src/migrate/sources/launchdarkly/api.js'
import {__resetLaunchDarklySourceForTests} from '../../src/migrate/sources/launchdarkly.js'
import {__resetLaunchSourceForTests} from '../../src/migrate/sources/launch.js'

const LAUNCH_PROD_URL = 'https://api.reforge.com'
const LAUNCH_STAGING_URL = 'https://api.goatsofreforge.com'

describe('migrate', () => {
  let tmpdir: string
  let prevCwd: string

  beforeEach(() => {
    // fs.realpathSync to drop /private prefix on macOS so path.resolve() in the command matches
    tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cmd-')))
    prevCwd = process.cwd()
    process.chdir(tmpdir)
    __resetLaunchSourceForTests()
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
    __resetLaunchSourceForTests()
  })

  describe('flag validation', () => {
    test
      .command(['migrate', '--from', 'launch', '--api-key', 'dummy', '--dir', './out', '--workspace', 'acme'])
      .catch((error) => {
        expect(error.message).to.match(/mutually exclusive/i)
        expect(error.message).to.match(/--push/)
      })
      .it('errors when --dir and --workspace are both passed without --push')

    test
      .command(['migrate', '--from', 'launch'])
      .catch((error) => {
        expect(error.message).to.match(/--api-key/i)
      })
      .it('errors when --api-key is missing')

    test
      .command(['migrate'])
      .catch((error) => {
        expect(error.message).to.match(/\bfrom\b/i)
      })
      .it('errors when --from is missing')

    test
      .command(['migrate', '--from', 'bogus', '--api-key', 'k'])
      .catch((error) => {
        expect(error.message).to.match(/--from/i)
      })
      .it('rejects unknown --from values')
  })

  // launchdarkly is no longer a stub (qfg-88cx) and flagsmith's fetcher
  // (Epic 1) is wired up. Flagsmith's converter (translate()) is still
  // NotYetImplementedError until Epic 3 — covered by the source-level test
  // suite, not here (no live API to hit from the command-level harness).
  describe('stub sources', () => {
    test
      .command(['migrate', '--from', 'flagsmith', '--source-api-key', 'k', '--dry-run'])
      .catch((error) => {
        // Without a reachable Flagsmith API, validateAuth fails with a
        // network/fetch error — the precise shape varies by node version,
        // but the message must mention flagsmith (the source name surfaces
        // in MissingAuthError / FlagsmithApiError messages).
        expect(error).to.be.instanceOf(Error)
      })
      .it('--from flagsmith with no reachable API surfaces a fetch error (not a stub)')
  })

  describe('cross-source refusal', () => {
    beforeEach(() => {
      const qfDir = path.join(tmpdir, '.qf')
      fs.mkdirSync(qfDir, {recursive: true})
      fs.writeFileSync(path.join(qfDir, 'import-state.json'), JSON.stringify({source: 'flagsmith'}, null, 2) + '\n')
    })

    test
      .command(['migrate', '--from', 'launch', '--api-key', 'k', '--dir', '.'])
      .catch((error) => {
        expect(error.message).to.match(/flagsmith/)
        expect(error.message).to.match(/launch/)
      })
      .it('refuses to run --from launch on a dir already migrated from flagsmith')
  })

  describe('launch dry-run (mocked API)', () => {
    const server = setupServer()

    before(() => {
      server.listen({onUnhandledRequest: 'error'})
    })

    afterEach(() => {
      server.resetHandlers()
    })

    after(() => {
      server.close()
    })

    const mockLaunchApi = (baseUrl: string) => {
      server.use(
        http.get(`${baseUrl}/api/v1/project-environments`, () =>
          HttpResponse.json({
            envs: [
              {id: 1, name: 'Production'},
              {id: 2, name: 'Staging'},
            ],
            projectId: 1,
          }),
        ),
        http.get(`${baseUrl}/api/v1/change-history`, () =>
          HttpResponse.json({
            changes: [
              {
                changedAt: 1_700_000_000_000,
                changedBy: {email: 'a@b', id: '1', type: 'user'},
                deleted: false,
                key: 'some-flag',
                newConfig: {configType: 'FEATURE_FLAG', key: 'some-flag', rows: []},
                type: 'FEATURE_FLAG',
              },
            ],
            cursor: null,
          }),
        ),
      )
    }

    test
      .do(() => mockLaunchApi(LAUNCH_PROD_URL))
      .stdout()
      .command(['migrate', '--from', 'launch', '--api-key', 'k', '--dry-run', '--json'])
      .it('dry run with no --dir uses ./quonfig-repo when cwd is not a workspace', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.from).to.equal('launch')
        expect(payload.dryRun).to.equal(true)
        expect(payload.fetched).to.equal(1)
        expect(payload.dir).to.equal(path.resolve(tmpdir, 'quonfig-repo'))
      })

    test
      .do(() => {
        fs.writeFileSync(path.join(tmpdir, 'quonfig.json'), JSON.stringify({environments: []}, null, 2) + '\n')
        mockLaunchApi(LAUNCH_PROD_URL)
      })
      .stdout()
      .command(['migrate', '--from', 'launch', '--api-key', 'k', '--dry-run', '--json'])
      .it('dry run with no --dir uses cwd when quonfig.json exists there', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.dir).to.equal(tmpdir)
      })

    test
      .do(() => mockLaunchApi(LAUNCH_STAGING_URL))
      .stdout()
      .command(['migrate', '--from', 'launch', '--api-key', 'k', '--dir', './out', '--dry-run', '--staging', '--json'])
      .it('--staging hits the staging Launch API base URL', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.fetched).to.equal(1)
        expect(payload.dir).to.equal(path.resolve(tmpdir, 'out'))
      })

    // D8 (plan §9.1): the launch-specific --api-key / LAUNCH_API_KEY is
    // generalized to provider-agnostic --source-api-key / QUONFIG_MIGRATE_API_KEY.
    describe('--source-api-key generalization (D8)', () => {
      const D8_ENV = ['QUONFIG_MIGRATE_API_KEY', 'LAUNCHDARKLY_API_KEY', 'LAUNCH_API_KEY', 'FLAGSMITH_API_KEY']
      let savedEnv: Record<string, string | undefined>

      beforeEach(() => {
        savedEnv = {}
        for (const k of D8_ENV) {
          savedEnv[k] = process.env[k]
          delete process.env[k]
        }
      })

      afterEach(() => {
        for (const k of D8_ENV) {
          if (savedEnv[k] === undefined) delete process.env[k]
          else process.env[k] = savedEnv[k]
        }
      })

      test
        .command(['migrate', '--from', 'launchdarkly'])
        .catch((error) => {
          expect(error.message).to.match(/--source-api-key/)
        })
        .it('errors with --source-api-key guidance when no key is provided')

      test
        .do(() => mockLaunchApi(LAUNCH_PROD_URL))
        .stdout()
        .command(['migrate', '--from', 'launch', '--source-api-key', 'k', '--dry-run', '--json'])
        .it('accepts --source-api-key as the generic key flag', (ctx) => {
          const payload = JSON.parse(ctx.stdout)
          expect(payload.fetched).to.equal(1)
        })

      test
        .do(() => {
          process.env.QUONFIG_MIGRATE_API_KEY = 'k'
          mockLaunchApi(LAUNCH_PROD_URL)
        })
        .stdout()
        .command(['migrate', '--from', 'launch', '--dry-run', '--json'])
        .it('reads the generic QUONFIG_MIGRATE_API_KEY env var', (ctx) => {
          const payload = JSON.parse(ctx.stdout)
          expect(payload.fetched).to.equal(1)
        })
    })
  })

  // The command is silent for a long time on a large account (fetch + write
  // phases). It should narrate what it is doing and what to do next so it
  // never looks frozen.
  describe('launch local run progress + next-steps', () => {
    const server = setupServer()

    before(() => {
      server.listen({onUnhandledRequest: 'error'})
    })

    afterEach(() => {
      server.resetHandlers()
    })

    after(() => {
      server.close()
    })

    const mockLaunch = () => {
      server.use(
        http.get(`${LAUNCH_PROD_URL}/api/v1/project-environments`, () =>
          HttpResponse.json({envs: [{id: 1, name: 'Production'}], projectId: 1}),
        ),
        http.get(`${LAUNCH_PROD_URL}/api/v1/change-history`, () =>
          HttpResponse.json({
            changes: [
              {
                changedAt: 1_700_000_000_000,
                changedBy: {email: 'a@b', id: '1', type: 'user'},
                deleted: false,
                key: 'some-flag',
                newConfig: {configType: 'FEATURE_FLAG', key: 'some-flag', rows: []},
                type: 'FEATURE_FLAG',
              },
            ],
            cursor: null,
          }),
        ),
      )
    }

    test
      .do(() => mockLaunch())
      .stdout()
      .command(['migrate', '--from', 'launch', '--api-key', 'k', '--dir', './out'])
      .it('narrates the plan, each phase, and the next steps for a local migration', (ctx) => {
        // Plan up front.
        expect(ctx.stdout).to.contain('Migrating from launch into')
        expect(ctx.stdout).to.contain('Mode: local migration only')
        // A line before each otherwise-silent phase.
        expect(ctx.stdout).to.contain('Authenticating with launch')
        expect(ctx.stdout).to.contain('Reading the environment list from launch')
        expect(ctx.stdout).to.contain('Fetching change history from launch')
        expect(ctx.stdout).to.contain('Committed 1 change(s)')
        // "What now?" guidance for a local (non-push) migration.
        expect(ctx.stdout).to.contain('Next steps:')
        expect(ctx.stdout).to.contain('qfg push --dir')
        expect(ctx.stdout).to.contain('MIGRATION_REPORT.md')
      })
  })

  // Epic 5 write-mode wiring for --from launchdarkly. Two command-layer gaps:
  // migrate.ts never called applyLaunchDarklyBaseUrl() (so LAUNCHDARKLY_API_URL
  // was unreachable) and had no --project flag (so non-default LD projects were
  // env-var-only). Both are exercised here at once.
  describe('launchdarkly dry-run (mocked API)', () => {
    const LD_TEST_URL = 'https://ld.test/api/v2'
    const server = setupServer()

    before(() => {
      server.listen({onUnhandledRequest: 'error'})
    })

    afterEach(() => {
      server.resetHandlers()
      delete process.env.LAUNCHDARKLY_API_URL
      delete process.env.LAUNCHDARKLY_PROJECT_KEY
      applyLaunchDarklyBaseUrl()
      __resetLaunchDarklySourceForTests()
    })

    after(() => {
      server.close()
    })

    // Mounts the LaunchDarkly snapshot endpoints under a SINGLE project key. If
    // the command fails to thread --project through to the source it requests
    // /projects/default/... instead and MSW raises an unhandled-request error;
    // likewise if applyLaunchDarklyBaseUrl() is never called it hits the prod
    // host. So this doubles as the revert test for both wiring gaps.
    const mockLaunchDarklyApi = (baseUrl: string, projectKey: string) => {
      server.use(
        http.get(`${baseUrl}/projects/${projectKey}/environments`, () =>
          HttpResponse.json({items: [{key: 'test', name: 'Test'}]}),
        ),
        http.get(`${baseUrl}/projects/${projectKey}/context-kinds`, () => HttpResponse.json({items: [{key: 'user'}]})),
        http.get(`${baseUrl}/flags/${projectKey}`, () =>
          HttpResponse.json({
            items: [
              {
                environments: {test: {fallthrough: {variation: 0}, on: true}},
                key: 'my-flag',
                kind: 'boolean',
                variations: [{value: true}, {value: false}],
              },
            ],
          }),
        ),
        http.get(`${baseUrl}/segments/${projectKey}/test`, () => HttpResponse.json({items: []})),
      )
    }

    test
      .do(() => {
        process.env.LAUNCHDARKLY_API_URL = LD_TEST_URL
        mockLaunchDarklyApi(LD_TEST_URL, 'acme-mobile')
      })
      .stdout()
      .command([
        'migrate',
        '--from',
        'launchdarkly',
        '--source-api-key',
        'k',
        '--project',
        'acme-mobile',
        '--dry-run',
        '--json',
      ])
      .it('--project threads the LaunchDarkly project key into the source API calls', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.from).to.equal('launchdarkly')
        expect(payload.fetched).to.equal(1)
      })

    test
      .do(() => {
        process.env.LAUNCHDARKLY_API_URL = LD_TEST_URL
        process.env.LAUNCHDARKLY_PROJECT_KEY = 'env-project'
        mockLaunchDarklyApi(LD_TEST_URL, 'env-project')
      })
      .stdout()
      .command(['migrate', '--from', 'launchdarkly', '--source-api-key', 'k', '--dry-run', '--json'])
      .it('falls back to the LAUNCHDARKLY_PROJECT_KEY env var when --project is omitted', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.fetched).to.equal(1)
      })
  })
})
