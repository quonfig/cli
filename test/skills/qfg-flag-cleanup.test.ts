import {expect} from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Structural test for the `qfg-flag-cleanup` Claude skill.
 *
 * The skill is invoked by `qfg cleanup remove` and must:
 *  - live at `cli/.claude/skills/qfg-flag-cleanup/SKILL.md`
 *  - carry a YAML front-matter `name` matching the directory + a `description`
 *    that contains the documented trigger phrases (so the skill loader can
 *    auto-discover it when an agent sees a `readyForCleanup` flag or runs any
 *    `qfg cleanup` command)
 *  - in the body, describe the documented workflow steps and the safety
 *    posture (no auto-merge, no re-checking telemetry)
 *
 * The exact prose can drift; what we lock in here is the contract the rest of
 * the codebase relies on: the file location, the front-matter shape, and the
 * trigger / workflow keywords. See bead qfg-olm2.5.
 */

describe('qfg-flag-cleanup skill', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '..', '..')
  const skillPath = path.join(repoRoot, '.claude', 'skills', 'qfg-flag-cleanup', 'SKILL.md')

  it('exists at cli/.claude/skills/qfg-flag-cleanup/SKILL.md', () => {
    expect(fs.existsSync(skillPath), `expected SKILL.md at ${skillPath}`).to.equal(true)
  })

  describe('front matter', () => {
    let frontMatter: string

    before(() => {
      const body = fs.readFileSync(skillPath, 'utf8').replaceAll('\r\n', '\n')
      const match = body.match(/^---\n([\S\s]*?)\n---/)
      expect(match, 'SKILL.md must open with a YAML front-matter block').to.not.equal(null)
      frontMatter = match![1]
    })

    it('declares name: qfg-flag-cleanup', () => {
      expect(frontMatter).to.match(/^name:\s*qfg-flag-cleanup\s*$/m)
    })

    it('includes the documented trigger phrases in the description', () => {
      const descMatch = frontMatter.match(/description:\s*([\S\s]*?)(?:\n[a-z][\w-]*:|$)/i)
      expect(descMatch, 'front matter must contain a description field').to.not.equal(null)
      const description = descMatch![1].toLowerCase()
      for (const phrase of [
        'retire flag',
        'clean up flag',
        'remove flag from code',
        'this flag is ready for cleanup',
        'qfg cleanup',
      ]) {
        expect(description, `description should mention "${phrase}" for skill loader auto-discovery`).to.include(phrase)
      }
    })
  })

  describe('body', () => {
    let body: string

    before(() => {
      body = fs.readFileSync(skillPath, 'utf8').replaceAll('\r\n', '\n')
    })

    it('points the agent at the .qf/cleanup/<key>.json payload as the source of truth', () => {
      expect(body).to.match(/\.qf\/cleanup/)
    })

    it('documents the per-flag winning-branch question (single ask)', () => {
      // Must capture the bool framing AND surface variant/config handling.
      expect(body.toLowerCase()).to.match(/(true branch|which.*winner|which.*variant|which value)/)
    })

    it('covers bool, variant, and config (non-bool) flag types', () => {
      const lower = body.toLowerCase()
      expect(lower).to.include('bool')
      expect(lower).to.include('variant')
      // At least one of the non-bool config value types should be named so the
      // agent knows the skill applies beyond booleans.
      expect(lower).to.match(/(string|int|double|json|string-list|duration|log[ _-]?level)/)
    })

    it('reminds the agent that the safety gate already ran in `qfg cleanup remove`', () => {
      expect(body.toLowerCase()).to.match(
        /safety gate.*qfg cleanup remove|already ran.*cleanup remove|cleanup remove.*already ran/,
      )
    })

    it('requires running the formatter + tests before opening the PR', () => {
      const lower = body.toLowerCase()
      expect(lower).to.match(/format/)
      expect(lower).to.match(/test/)
    })

    it('explicitly never auto-merges (same posture as qfg migrate my-code)', () => {
      expect(body.toLowerCase()).to.match(/(never auto[ -]?merge|do(es)? not auto[ -]?merge|don'?t auto[ -]?merge)/)
    })

    it('scopes work to the current cwd / repo (no cross-repo discovery)', () => {
      expect(body.toLowerCase()).to.match(/(current.*(repo|cwd|directory)|one pr per repo|cwd only)/)
    })
  })
})
