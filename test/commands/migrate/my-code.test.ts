import {expect, test} from '@oclif/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('migrate my-code', () => {
  let tmpdir: string
  let prevCwd: string

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-my-code-test-'))
    prevCwd = process.cwd()
    process.chdir(tmpdir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
  })

  describe('when .qf/identifier-map.json is missing', () => {
    test
      .command(['migrate:my-code'])
      .catch((error) => {
        expect(error.message).to.match(/identifier-map\.json/)
        expect(error.message).to.match(/qfg migrate/)
      })
      .it('errors with a clear message pointing at qfg migrate')
  })

  describe('when .qf/identifier-map.json exists', () => {
    beforeEach(() => {
      const qfDir = path.join(tmpdir, '.qf')
      fs.mkdirSync(qfDir, {recursive: true})
      fs.writeFileSync(
        path.join(qfDir, 'identifier-map.json'),
        JSON.stringify({'my-flag': 'my_flag', 'other-flag': 'other_flag'}, null, 2) + '\n',
      )
    })

    test
      .stdout()
      .command(['migrate:my-code'])
      .it('prints the skill name and remapping count', (ctx) => {
        expect(ctx.stdout).to.contain('qfg-migrate-code')
        expect(ctx.stdout).to.contain('2 identifier remapping')
      })

    test
      .stdout()
      .command(['migrate:my-code', '--json'])
      .it('returns a JSON payload with skill and mappings', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output.skill).to.equal('qfg-migrate-code')
        expect(output.from).to.equal('launch')
        expect(output.mappings).to.deep.equal({'my-flag': 'my_flag', 'other-flag': 'other_flag'})
        expect(output.mappingCount).to.equal(2)
        expect(output.dryRun).to.equal(false)
      })

    test
      .stdout()
      .command(['migrate:my-code', '--dry-run'])
      .it('marks dry-run mode in output', (ctx) => {
        expect(ctx.stdout.toLowerCase()).to.contain('dry-run')
      })

    test
      .stdout()
      .command(['migrate:my-code', '--from', 'launchdarkly'])
      .catch((error) => {
        expect(error.message).to.match(/launch/)
      })
      .it('rejects unsupported --from sources')
  })

  describe('when the identifier map file is in a parent directory', () => {
    beforeEach(() => {
      const qfDir = path.join(tmpdir, '.qf')
      fs.mkdirSync(qfDir, {recursive: true})
      fs.writeFileSync(
        path.join(qfDir, 'identifier-map.json'),
        JSON.stringify({'parent-flag': 'parent_flag'}, null, 2) + '\n',
      )
      const sub = path.join(tmpdir, 'sub')
      fs.mkdirSync(sub)
      process.chdir(sub)
    })

    test
      .stdout()
      .command(['migrate:my-code', '--json'])
      .it('walks up to find .qf/identifier-map.json', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output.mappings).to.deep.equal({'parent-flag': 'parent_flag'})
      })
  })
})
