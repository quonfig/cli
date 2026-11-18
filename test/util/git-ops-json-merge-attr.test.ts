/**
 * qfg-5bjew.28: clones qfg manages carry `*.json -merge` in
 * `.git/info/attributes`, so `git merge origin/main` stops on a flag file
 * changed on both sides instead of combining the edits line by line.
 */

import {expect} from 'chai'
import {execFile as execFileCb} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as util from 'node:util'

import {JSON_NO_MERGE_ATTRIBUTE, ensureJsonNoMergeAttribute} from '../../src/util/git-ops.js'

const execFile = util.promisify(execFileCb)

async function git(dir: string, ...args: string[]): Promise<string> {
  const {stdout} = await execFile('git', ['-C', dir, ...args])
  return stdout
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-q', '--initial-branch=main')
  await git(dir, 'config', 'user.email', 'test@quonfig.test')
  await git(dir, 'config', 'user.name', 'Test')
  await git(dir, 'config', 'commit.gpgsign', 'false')
}

const attributesPath = (dir: string) => path.join(dir, '.git', 'info', 'attributes')

// A flag file whose rules sit on separate lines, so git's line merge would
// combine a criteria edit on one side with a value edit on the other.
const flagJson = (criteria: string, value: string, extra = '') =>
  [
    '{',
    '  "key": "cr.conflict",',
    '  "rules": [',
    '    {',
    `      "criteria": "${criteria}",`,
    '      "unrelated1": 1,',
    '      "unrelated2": 2,',
    '      "unrelated3": 3,',
    `      "value": ${value}`,
    `    }${extra}`,
    '  ]',
    '}',
    '',
  ].join('\n')

describe('ensureJsonNoMergeAttribute (qfg-5bjew.28)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-json-merge-'))
    await initRepo(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {force: true, recursive: true})
  })

  it('writes the attribute once and is a no-op the second time', async () => {
    expect(JSON_NO_MERGE_ATTRIBUTE).to.equal('*.json -merge')
    expect(await ensureJsonNoMergeAttribute(tmpDir)).to.equal(true)
    expect(await ensureJsonNoMergeAttribute(tmpDir)).to.equal(false)
    const lines = fs.readFileSync(attributesPath(tmpDir), 'utf8').split('\n')
    expect(lines.filter((l) => l === '*.json -merge')).to.have.length(1)
  })

  it('keeps existing lines and appends after a file with no trailing newline', async () => {
    fs.mkdirSync(path.dirname(attributesPath(tmpDir)), {recursive: true})
    fs.writeFileSync(attributesPath(tmpDir), '*.png binary')
    await ensureJsonNoMergeAttribute(tmpDir)
    expect(fs.readFileSync(attributesPath(tmpDir), 'utf8')).to.equal('*.png binary\n*.json -merge\n')
  })

  it('leaves a file that already has the line untouched', async () => {
    fs.mkdirSync(path.dirname(attributesPath(tmpDir)), {recursive: true})
    fs.writeFileSync(attributesPath(tmpDir), '  *.json -merge  \n*.md text\n')
    expect(await ensureJsonNoMergeAttribute(tmpDir)).to.equal(false)
    expect(fs.readFileSync(attributesPath(tmpDir), 'utf8')).to.equal('  *.json -merge  \n*.md text\n')
  })

  it('never writes a committed .gitattributes', async () => {
    await ensureJsonNoMergeAttribute(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, '.gitattributes'))).to.equal(false)
  })

  describe('merging main into a branch', () => {
    const setup = async () => {
      fs.mkdirSync(path.join(tmpDir, 'feature-flags'))
      const flag = path.join(tmpDir, 'feature-flags', 'cr.conflict.json')
      const other = path.join(tmpDir, 'feature-flags', 'other.json')
      fs.writeFileSync(flag, flagJson('old', 'false'))
      fs.writeFileSync(other, flagJson('old', 'false'))
      await git(tmpDir, 'add', '-A')
      await git(tmpDir, 'commit', '-q', '-m', 'base')

      await git(tmpDir, 'checkout', '-q', '-b', 'cr-branch')
      fs.writeFileSync(flag, flagJson('old', 'true'))
      await git(tmpDir, 'commit', '-q', '-am', 'branch: flip value')

      await git(tmpDir, 'checkout', '-q', 'main')
      fs.writeFileSync(flag, flagJson('main-only', 'false'))
      fs.writeFileSync(other, flagJson('main-edit', 'false'))
      await git(tmpDir, 'commit', '-q', '-am', 'main: change criteria')
      await git(tmpDir, 'checkout', '-q', 'cr-branch')
    }

    it('without the attribute, git silently combines both-sides edits (the hazard)', async () => {
      await setup()
      await git(tmpDir, 'merge', '-q', '--no-edit', 'main')
      const merged = fs.readFileSync(path.join(tmpDir, 'feature-flags', 'cr.conflict.json'), 'utf8')
      expect(merged).to.equal(flagJson('main-only', 'true'))
    })

    it('with the attribute, a JSON file changed on both sides conflicts; a one-sided file still merges', async () => {
      await setup()
      await ensureJsonNoMergeAttribute(tmpDir)
      let failed = false
      try {
        await git(tmpDir, 'merge', '--no-edit', 'main')
      } catch (error: unknown) {
        failed = true
        expect(String((error as {stdout?: string}).stdout)).to.contain('CONFLICT')
      }

      expect(failed, 'merge should stop on the both-sides file').to.equal(true)
      const unmerged = (await git(tmpDir, 'diff', '--name-only', '--diff-filter=U')).trim()
      expect(unmerged).to.equal('feature-flags/cr.conflict.json')
      // One-sided edit from main came in normally.
      const other = fs.readFileSync(path.join(tmpDir, 'feature-flags', 'other.json'), 'utf8')
      expect(other).to.equal(flagJson('main-edit', 'false'))
    })
  })

  it('resolves the attributes file inside a linked worktree', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a\n')
    await git(tmpDir, 'add', '-A')
    await git(tmpDir, 'commit', '-q', '-m', 'base')
    const wt = `${tmpDir}-wt`
    try {
      await git(tmpDir, 'worktree', 'add', '-q', '-b', 'wt', wt)
      expect(await ensureJsonNoMergeAttribute(wt)).to.equal(true)
      const commonInfo = (await git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'info/attributes')).trim()
      expect(fs.readFileSync(commonInfo, 'utf8')).to.contain('*.json -merge')
    } finally {
      fs.rmSync(wt, {force: true, recursive: true})
    }
  })
})
