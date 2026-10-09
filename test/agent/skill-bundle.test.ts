import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {SKILL_FILES, SKILL_NAME, SKILL_VERSION} from '../../src/agent/skill-bundle.generated.js'

// qfg-y3x1: the cli vendors github.com/quonfig/skills at build time via a
// checked-in generated module. These tests lock the bundle's shape and, when a
// skills checkout is available (monorepo sibling ../skills or
// $QUONFIG_SKILLS_DIR), fail on drift between it and the vendored copy.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('vendored Quonfig agent skill bundle', () => {
  it('ships SKILL.md with name/description front matter and a semver version', () => {
    expect(SKILL_NAME).to.equal('quonfig')
    expect(SKILL_VERSION).to.match(/^\d+\.\d+\.\d+$/)
    const skill = SKILL_FILES.find((f) => f.path === 'SKILL.md')
    expect(skill, 'SKILL.md in bundle').to.not.equal(undefined)
    expect(skill!.content).to.match(/^---\nname: quonfig\ndescription: .+\n/)
  })

  it('every references/ file SKILL.md links to is in the bundle', () => {
    const skill = SKILL_FILES.find((f) => f.path === 'SKILL.md')!.content
    const linked = [...skill.matchAll(/\((references\/[\w.-]+\.md)\)/g)].map((m) => m[1])
    expect(linked.length).to.be.greaterThan(0)
    const paths = new Set(SKILL_FILES.map((f) => f.path))
    for (const rel of linked) expect(paths.has(rel), rel).to.equal(true)
  })

  it('matches the skills repo checkout (drift guard)', function () {
    const skillsDir = path.resolve(process.env.QUONFIG_SKILLS_DIR ?? path.join(repoRoot, '..', 'skills'))
    if (!fs.existsSync(path.join(skillsDir, 'plugins', 'quonfig'))) {
      this.skip()
    }

    const res = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'sync-agent-skill.mjs'), '--check'], {
      encoding: 'utf8',
      env: {...process.env, QUONFIG_SKILLS_DIR: skillsDir},
    })
    expect(res.status, res.stderr).to.equal(0)
  })
})
