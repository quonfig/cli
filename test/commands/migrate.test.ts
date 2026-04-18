import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
      .command([
        'migrate',
        '--from',
        'launch',
        '--api-key',
        'dummy',
        '--dir',
        './out',
        '--workspace',
        'acme',
      ])
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

  describe('stub sources', () => {
    test
      .command(['migrate', '--from', 'launchdarkly', '--api-key', 'k', '--dry-run'])
      .catch((error) => {
        expect(error.message).to.match(/not yet implemented/i)
        expect(error.message).to.match(/launchdarkly/)
      })
      .it('--from launchdarkly throws NotYetImplementedError')

    test
      .command(['migrate', '--from', 'flagsmith', '--api-key', 'k', '--dry-run'])
      .catch((error) => {
        expect(error.message).to.match(/not yet implemented/i)
        expect(error.message).to.match(/flagsmith/)
      })
      .it('--from flagsmith throws NotYetImplementedError')
  })

  describe('cross-source refusal', () => {
    beforeEach(() => {
      const qfDir = path.join(tmpdir, '.qf')
      fs.mkdirSync(qfDir, {recursive: true})
      fs.writeFileSync(
        path.join(qfDir, 'import-state.json'),
        JSON.stringify({source: 'flagsmith'}, null, 2) + '\n',
      )
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
      .it('dry run with no --dir uses ./quonfig-config when cwd is not a workspace', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.from).to.equal('launch')
        expect(payload.dryRun).to.equal(true)
        expect(payload.fetched).to.equal(1)
        expect(payload.dir).to.equal(path.resolve(tmpdir, 'quonfig-config'))
      })

    test
      .do(() => {
        fs.writeFileSync(
          path.join(tmpdir, 'quonfig.json'),
          JSON.stringify({environments: []}, null, 2) + '\n',
        )
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
      .command([
        'migrate',
        '--from',
        'launch',
        '--api-key',
        'k',
        '--dir',
        './out',
        '--dry-run',
        '--staging',
        '--json',
      ])
      .it('--staging hits the staging Launch API base URL', (ctx) => {
        const payload = JSON.parse(ctx.stdout)
        expect(payload.fetched).to.equal(1)
        expect(payload.dir).to.equal(path.resolve(tmpdir, 'out'))
      })
  })
})
