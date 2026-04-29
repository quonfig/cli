import {expect} from 'chai'
import {execFile as execFileCb} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as util from 'node:util'

import {addAndCommitFile, commitPinFixIfPinOnly, dirtyTrackedFiles, hasFileChanges} from '../../src/util/git-ops.js'

const execFile = util.promisify(execFileCb)

async function git(dir: string, ...args: string[]): Promise<string> {
  const {stdout} = await execFile('git', ['-C', dir, ...args])
  return stdout
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-q')
  await git(dir, 'config', 'user.email', 'test@quonfig.test')
  await git(dir, 'config', 'user.name', 'Test')
  await git(dir, 'config', 'commit.gpgsign', 'false')
}

describe('git-ops pin helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-test-'))
    await initRepo(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {force: true, recursive: true})
  })

  describe('hasFileChanges', () => {
    it('returns false when the file matches HEAD', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}\n')
      await git(tmpDir, 'add', 'quonfig.json')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      expect(await hasFileChanges(tmpDir, 'quonfig.json')).to.equal(false)
    })

    it('returns true when the file has unstaged edits', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}\n')
      await git(tmpDir, 'add', 'quonfig.json')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{"workspace":"x"}\n')

      expect(await hasFileChanges(tmpDir, 'quonfig.json')).to.equal(true)
    })

    it('returns true when the file is untracked', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}\n')
      expect(await hasFileChanges(tmpDir, 'quonfig.json')).to.equal(true)
    })
  })

  describe('dirtyTrackedFiles', () => {
    it('lists tracked files with unstaged edits', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}\n')
      fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}\n')
      await git(tmpDir, 'add', '.')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      fs.writeFileSync(path.join(tmpDir, 'a.json'), '{"x":1}\n')

      expect(await dirtyTrackedFiles(tmpDir)).to.deep.equal(['a.json'])
    })

    it('excludes untracked files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}\n')
      await git(tmpDir, 'add', '.')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      // Untracked
      fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}\n')

      expect(await dirtyTrackedFiles(tmpDir)).to.deep.equal([])
    })

    it('returns empty when working tree is clean', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}\n')
      await git(tmpDir, 'add', '.')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      expect(await dirtyTrackedFiles(tmpDir)).to.deep.equal([])
    })
  })

  describe('addAndCommitFile', () => {
    it('commits a single file and returns true', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}\n')
      await git(tmpDir, 'add', 'quonfig.json')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{"workspace":"acme"}\n')

      const committed = await addAndCommitFile(tmpDir, 'quonfig.json', 'qfg: pin workspace = acme')
      expect(committed).to.equal(true)

      const log = await git(tmpDir, 'log', '--pretty=format:%s')
      expect(log.split('\n')[0]).to.equal('qfg: pin workspace = acme')

      const status = await git(tmpDir, 'status', '--porcelain')
      expect(status.trim()).to.equal('')
    })

    it('returns false and does not commit when the file matches HEAD', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}\n')
      await git(tmpDir, 'add', 'quonfig.json')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      const before = await git(tmpDir, 'rev-parse', 'HEAD')

      const committed = await addAndCommitFile(tmpDir, 'quonfig.json', 'no-op')
      expect(committed).to.equal(false)

      const after = await git(tmpDir, 'rev-parse', 'HEAD')
      expect(after).to.equal(before)
    })

    it('only commits the named file, not other staged changes', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}\n')
      fs.writeFileSync(path.join(tmpDir, 'other.json'), '{}\n')
      await git(tmpDir, 'add', '.')
      await git(tmpDir, 'commit', '-m', 'init', '-q')

      // Stage an unrelated change.
      fs.writeFileSync(path.join(tmpDir, 'other.json'), '{"changed":true}\n')
      await git(tmpDir, 'add', 'other.json')

      // Now make a quonfig.json change and commit only that.
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{"workspace":"acme"}\n')
      const committed = await addAndCommitFile(tmpDir, 'quonfig.json', 'pin')
      expect(committed).to.equal(true)

      // The other staged change should still be staged but not committed.
      const status = await git(tmpDir, 'status', '--porcelain')
      expect(status).to.include('other.json')

      // The new commit should only touch quonfig.json.
      const showStat = await git(tmpDir, 'show', '--stat', '--name-only', '--pretty=format:', 'HEAD')
      const files = showStat
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(files).to.deep.equal(['quonfig.json'])
    })
  })

  describe('commitPinFixIfPinOnly', () => {
    async function seedHead(file: string, body: string): Promise<void> {
      fs.writeFileSync(path.join(tmpDir, file), body)
      await git(tmpDir, 'add', file)
      await git(tmpDir, 'commit', '-m', 'init', '-q')
    }

    it('returns clean when the file matches HEAD', async () => {
      await seedHead('quonfig.json', '{"environments":["prod"]}\n')
      const result = await commitPinFixIfPinOnly(tmpDir, 'quonfig.json', 'acme')
      expect(result).to.deep.equal({kind: 'clean'})
    })

    it('commits when the only diff is an added matching workspace pin', async () => {
      await seedHead(
        'quonfig.json',
        `{
  "environments": ["production", "staging", "development"]
}
`,
      )

      // Simulate the working-tree pin write produced by `qfg pull`.
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        `{
  "environments": ["production", "staging", "development"],
  "workspace": "our-config"
}
`,
      )

      const result = await commitPinFixIfPinOnly(tmpDir, 'quonfig.json', 'our-config')
      expect(result).to.deep.equal({kind: 'committed', slug: 'our-config'})

      const log = await git(tmpDir, 'log', '--pretty=format:%s')
      expect(log.split('\n')[0]).to.equal('qfg: pin workspace = our-config')

      const status = await git(tmpDir, 'status', '--porcelain')
      expect(status.trim()).to.equal('')
    })

    it('skips when the working-tree pin does not match the backend slug', async () => {
      await seedHead('quonfig.json', '{"environments":["prod"]}\n')
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{"environments":["prod"],"workspace":"wrong"}\n')

      const result = await commitPinFixIfPinOnly(tmpDir, 'quonfig.json', 'right')
      expect(result.kind).to.equal('skipped')

      // Working tree must be untouched.
      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      expect(raw).to.include('"workspace":"wrong"')
    })

    it('skips when the working tree has changes beyond the pin', async () => {
      await seedHead('quonfig.json', '{"environments":["prod"]}\n')
      // Pin matches AND environments was edited — too risky to commit silently.
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        '{"environments":["prod","stage"],"workspace":"acme"}\n',
      )

      const result = await commitPinFixIfPinOnly(tmpDir, 'quonfig.json', 'acme')
      expect(result.kind).to.equal('skipped')

      const log = await git(tmpDir, 'log', '--pretty=format:%s')
      expect(log).to.equal('init')
    })

    it('skips when the working-tree file is not valid JSON', async () => {
      await seedHead('quonfig.json', '{"environments":[]}\n')
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{ broken')

      const result = await commitPinFixIfPinOnly(tmpDir, 'quonfig.json', 'acme')
      expect(result.kind).to.equal('skipped')
    })
  })
})
