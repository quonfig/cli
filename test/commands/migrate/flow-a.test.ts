import {Config} from '@oclif/core'
import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import Migrate from '../../../src/commands/migrate.js'
import {__resetLaunchSourceForTests} from '../../../src/migrate/sources/launch.js'

const LAUNCH_PROD_URL = 'https://api.reforge.com'

const USER = {email: 'a@b', id: '1', type: 'user'}

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function logSubjects(dir: string): string[] {
  return git(dir, 'log', '--pretty=format:%s').split('\n').filter(Boolean)
}

function makeChange(key: string, changedAt: number, value: {type: string; value: unknown}) {
  return {
    changedAt,
    changedBy: USER,
    deleted: false,
    key,
    newConfig: {
      default: {
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value,
          },
        ],
      },
      environments: [],
      id: `id-${key}-${changedAt}`,
      key,
      projectId: 'p',
      type: 'feature_flag',
      valueType: value.type,
    },
    newConfigId: `${changedAt}`,
    type: 'FEATURE_FLAG',
  }
}

/**
 * Flow A (local, no Quonfig service) — see project/plans/qfg-migrate.md.
 *
 * Verifies the migrate command in local-dir mode:
 *   1. writes a complete datadir workspace matching the sdk-node/sdk-go format
 *   2. initializes git + commits the initial import as a single commit
 *   3. re-running picks up the delta and produces exactly one new commit
 *   4. import-state cursor advances on each run
 */
describe('qfg migrate --from launch --dir ./out (Flow A)', () => {
  let tmpdir: string
  let prevCwd: string
  let config: Config
  const server = setupServer()

  before(async () => {
    server.listen({onUnhandledRequest: 'error'})
    config = await Config.load(CLI_ROOT)
  })

  after(() => {
    server.close()
  })

  beforeEach(() => {
    tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-flow-a-')))
    prevCwd = process.cwd()
    process.chdir(tmpdir)
    __resetLaunchSourceForTests()
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
    server.resetHandlers()
    __resetLaunchSourceForTests()
  })

  const mockLaunch = (changes: ReturnType<typeof makeChange>[]) => {
    server.use(
      http.get(`${LAUNCH_PROD_URL}/api/v1/project-environments`, () =>
        HttpResponse.json({
          envs: [
            {id: 1, name: 'Production'},
            {id: 2, name: 'Staging'},
          ],
          projectId: 1,
        }),
      ),
      http.get(`${LAUNCH_PROD_URL}/api/v1/change-history`, () => HttpResponse.json({changes, cursor: null})),
    )
  }

  const runMigrate = async (outDir: string) =>
    Migrate.run(['--from', 'launch', '--api-key', 'k', '--dir', outDir, '--json'], config)

  it('initial run writes a complete datadir workspace and makes exactly one git commit', async () => {
    mockLaunch([makeChange('my-feature', 1_700_000_000_000, {type: 'bool', value: false})])

    const outDir = path.join(tmpdir, 'out')
    await runMigrate(outDir)

    // Git repo initialized with a single migrator commit.
    expect(fs.existsSync(path.join(outDir, '.git'))).to.equal(true)
    expect(logSubjects(outDir)).to.have.length(1)

    // Feature flag file written to the sdk-node/sdk-go datadir layout.
    const flagPath = path.join(outDir, 'feature-flags', 'my-feature.json')
    expect(fs.existsSync(flagPath)).to.equal(true)
    const flag = JSON.parse(fs.readFileSync(flagPath, 'utf8'))
    expect(flag.key).to.equal('my-feature')
    expect(flag.type).to.equal('feature_flag')
    expect(flag.valueType).to.equal('bool')
    expect(flag.default.rules[0].value).to.deep.equal({type: 'bool', value: false})

    // quonfig.json with the discovered environments (canonical datadir format for sdk-node/go).
    const quonfigJsonPath = path.join(outDir, 'quonfig.json')
    expect(fs.existsSync(quonfigJsonPath)).to.equal(true)
    const quonfig = JSON.parse(fs.readFileSync(quonfigJsonPath, 'utf8'))
    expect(quonfig.environments).to.include.members(['production', 'staging'])

    // .qf/import-state.json with source + cursor.
    const state = JSON.parse(fs.readFileSync(path.join(outDir, '.qf', 'import-state.json'), 'utf8'))
    expect(state.source).to.equal('launch')
    expect(state.lastProcessedAt).to.equal(1_700_000_000_000)
  })

  it('re-run picks up deltas: exactly one new commit, flag value updated, cursor advanced', async () => {
    const outDir = path.join(tmpdir, 'out')

    // First run: flag false
    mockLaunch([makeChange('my-feature', 1_700_000_000_000, {type: 'bool', value: false})])
    await runMigrate(outDir)

    expect(logSubjects(outDir)).to.have.length(1)
    const flagV1 = JSON.parse(fs.readFileSync(path.join(outDir, 'feature-flags', 'my-feature.json'), 'utf8'))
    expect(flagV1.default.rules[0].value).to.deep.equal({type: 'bool', value: false})

    // Second run: Launch reports the same flag flipped to true with a newer changedAt.
    __resetLaunchSourceForTests()
    server.resetHandlers()
    // Launch change-history API returns newest-first; the migrator stops at the cursor.
    mockLaunch([
      makeChange('my-feature', 1_800_000_000_000, {type: 'bool', value: true}),
      makeChange('my-feature', 1_700_000_000_000, {type: 'bool', value: false}),
    ])

    await runMigrate(outDir)

    // Exactly one new commit (2 total).
    expect(logSubjects(outDir)).to.have.length(2)

    // File content reflects the new value.
    const flagV2 = JSON.parse(fs.readFileSync(path.join(outDir, 'feature-flags', 'my-feature.json'), 'utf8'))
    expect(flagV2.default.rules[0].value).to.deep.equal({type: 'bool', value: true})

    // Cursor advanced.
    const state = JSON.parse(fs.readFileSync(path.join(outDir, '.qf', 'import-state.json'), 'utf8'))
    expect(state.lastProcessedAt).to.equal(1_800_000_000_000)
  })
})
