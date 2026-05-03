import {expect} from 'chai'
import {execFile as execFileCb} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as util from 'node:util'

import {getOriginMainSha} from '../../src/util/git-ops.js'

const execFile = util.promisify(execFileCb)

async function git(dir: string, ...args: string[]): Promise<string> {
  const {stdout} = await execFile('git', ['-C', dir, ...args])
  return stdout
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.email', 'test@quonfig.test')
  await git(dir, 'config', 'user.name', 'Test')
  await git(dir, 'config', 'commit.gpgsign', 'false')
}

async function commitFile(dir: string, file: string, content: string, msg: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), content)
  await git(dir, 'add', file)
  await git(dir, 'commit', '-m', msg, '-q')
}

describe('getOriginMainSha (qfg-gj3i)', () => {
  it('returns the SHA of origin/main after a clean clone + fetch', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-origin-remote-'))
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-origin-local-'))
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-origin-seed-'))
    try {
      await execFile('git', ['init', '-q', '--bare', '-b', 'main', remote])

      await initRepo(seed)
      await commitFile(seed, 'a.json', '{"v":1}', 'one')
      await git(seed, 'remote', 'add', 'origin', remote)
      await git(seed, 'push', '-q', 'origin', 'main')
      const expected = (await git(seed, 'rev-parse', 'HEAD')).trim()

      await execFile('git', ['clone', '-q', remote, local])
      // fetch so origin/main exists; clone already creates it but be explicit.
      await git(local, 'fetch', '-q', 'origin')

      const result = await getOriginMainSha(local)
      expect(result).to.equal(expected)
    } finally {
      fs.rmSync(remote, {force: true, recursive: true})
      fs.rmSync(local, {force: true, recursive: true})
      fs.rmSync(seed, {force: true, recursive: true})
    }
  })

  it('returns undefined on a brand-new repo with no origin/main ref', async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-origin-fresh-'))
    try {
      await initRepo(local)
      await commitFile(local, 'a.json', '{"v":1}', 'init')
      // No remote configured, no fetch — origin/main does not exist.
      const result = await getOriginMainSha(local)
      expect(result).to.equal(undefined)
    } finally {
      fs.rmSync(local, {force: true, recursive: true})
    }
  })

  it('returns undefined on a non-git directory (bare-path push)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-origin-nogit-'))
    try {
      const result = await getOriginMainSha(tmp)
      expect(result).to.equal(undefined)
    } finally {
      fs.rmSync(tmp, {force: true, recursive: true})
    }
  })
})
