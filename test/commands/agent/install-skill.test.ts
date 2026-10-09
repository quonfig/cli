import {expect, test} from '@oclif/test'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {SKILL_FILES, SKILL_VERSION} from '../../../src/agent/skill-bundle.generated.js'

// qfg-y3x1: `qfg agent install-skill` writes the vendored Quonfig agent skill
// (github.com/quonfig/skills) into an application repo.

const SKILL_MD = SKILL_FILES.find((f) => f.path === 'SKILL.md')!.content
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

describe('agent install-skill', () => {
  let tmp: string
  let origCwd: string
  const skillDir = () => path.join(tmp, '.claude', 'skills', 'quonfig')
  const read = (rel: string) => fs.readFileSync(path.join(skillDir(), rel), 'utf8')

  beforeEach(() => {
    origCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-install-skill-'))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(origCwd)
    fs.rmSync(tmp, {force: true, recursive: true})
  })

  test
    .stdout()
    .command(['agent install-skill'])
    .it('writes every skill file, byte-identical to the vendored bundle, plus a manifest', (ctx) => {
      expect(SKILL_MD).to.match(/^---\nname: quonfig\n/)
      for (const f of SKILL_FILES) {
        expect(read(f.path), f.path).to.equal(f.content)
      }

      const manifest = JSON.parse(read('.quonfig-skill.json'))
      expect(manifest.version).to.equal(SKILL_VERSION)
      expect(manifest.files['SKILL.md']).to.equal(sha256(SKILL_MD))
      expect(ctx.stdout).to.contain(`Quonfig skill v${SKILL_VERSION}`)
      expect(ctx.stdout).to.contain('created')
      expect(ctx.stdout).to.contain('--add-pointer')
    })

  test
    .stdout()
    .command(['agent install-skill'])
    .command(['agent install-skill', '--json'])
    .it('is idempotent: a second run reports every file unchanged', (ctx) => {
      const json = JSON.parse(ctx.stdout.slice(ctx.stdout.indexOf('{')))
      expect(json.counts).to.deep.equal({unchanged: SKILL_FILES.length})
      expect(read('SKILL.md')).to.equal(SKILL_MD)
    })

  test
    .stdout()
    .command(['agent install-skill'])
    .do(() => fs.writeFileSync(path.join(skillDir(), 'SKILL.md'), SKILL_MD + '\nOur team note.\n'))
    .command(['agent install-skill'])
    .catch((error) => {
      expect(error.message).to.contain('SKILL.md')
      expect(error.message).to.contain('--force')
    })
    .it('refuses to clobber a customer-edited file without --force', () => {
      expect(read('SKILL.md')).to.contain('Our team note.')
    })

  test
    .stdout()
    .command(['agent install-skill'])
    .do(() => fs.writeFileSync(path.join(skillDir(), 'SKILL.md'), 'edited'))
    .command(['agent install-skill', '--force'])
    .it('--force overwrites a customer-edited file', () => {
      expect(read('SKILL.md')).to.equal(SKILL_MD)
    })

  test
    .stdout()
    .do(() => {
      // Simulate an older qfg-installed version: content differs from this
      // build, but the manifest says it is exactly what qfg wrote.
      fs.mkdirSync(skillDir(), {recursive: true})
      const old = 'old skill v0\n'
      fs.writeFileSync(path.join(skillDir(), 'SKILL.md'), old)
      fs.writeFileSync(path.join(skillDir(), 'references-old.md'), 'gone\n')
      fs.writeFileSync(
        path.join(skillDir(), '.quonfig-skill.json'),
        JSON.stringify({
          files: {'SKILL.md': sha256(old), 'references-old.md': sha256('gone\n')},
          skill: 'quonfig',
          version: '0.0.1',
        }),
      )
    })
    .command(['agent install-skill'])
    .it('upgrades files it wrote earlier without --force and removes files no longer shipped', (ctx) => {
      expect(read('SKILL.md')).to.equal(SKILL_MD)
      expect(fs.existsSync(path.join(skillDir(), 'references-old.md'))).to.equal(false)
      expect(ctx.stdout).to.match(/updated\s+SKILL\.md/)
      expect(ctx.stdout).to.match(/removed\s+references-old\.md/)
    })

  test
    .stdout()
    .command(['agent install-skill', '--add-pointer'])
    .command(['agent install-skill', '--add-pointer'])
    .it('--add-pointer adds one AGENTS.md line pointing at the skill, idempotently', (ctx) => {
      const agents = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8')
      expect(agents.match(/\.claude\/skills\/quonfig\/SKILL\.md/g)).to.have.length(1)
      expect(ctx.stdout).to.contain('AGENTS.md already points at the skill')
    })

  test
    .stdout()
    .command(['agent install-skill', '--dir', '.agents/skills'])
    .it('--dir installs into another skills directory', () => {
      expect(fs.readFileSync(path.join(tmp, '.agents', 'skills', 'quonfig', 'SKILL.md'), 'utf8')).to.equal(SKILL_MD)
    })
})
