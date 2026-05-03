/**
 * Real-git tests for gitPullRebase — the engine behind `qfg pull --rebase`
 * (qfg-4tey). Three outcomes the caller must distinguish:
 *
 *   1. clean      — rebase applied without conflicts, working tree usable.
 *   2. conflicts  — rebase paused; conflict markers planted in listed files.
 *   3. failed     — could not start rebase (precondition error).
 */

import {expect} from 'chai'
import {execFile as execFileCb} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as util from 'node:util'

import {gitPullRebase} from '../../src/util/git-ops.js'

const execFile = util.promisify(execFileCb)

async function git(dir: string, ...args: string[]): Promise<string> {
  const {stdout} = await execFile('git', ['-C', dir, ...args])
  return stdout
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'config', 'user.email', 'test@quonfig.test')
  await git(dir, 'config', 'user.name', 'Test')
  await git(dir, 'config', 'commit.gpgsign', 'false')
}

async function commitFile(dir: string, file: string, content: string, msg: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), content)
  await git(dir, 'add', file)
  await git(dir, 'commit', '-m', msg, '-q')
}

describe('gitPullRebase (qfg-4tey)', () => {
  let remote: string
  let local: string
  let producer: string

  beforeEach(async () => {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-remote-'))
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-local-'))
    producer = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-producer-'))
    await execFile('git', ['init', '-q', '--bare', '-b', 'main', remote])

    // Seed remote with a base commit via producer.
    await execFile('git', ['clone', '-q', remote, producer])
    await initRepo(producer)
    await commitFile(producer, 'a.json', '{"v":"base"}\n', 'base')
    await git(producer, 'push', '-q', 'origin', 'main')

    // Local clones from the seeded base.
    await execFile('git', ['clone', '-q', remote, local])
    await initRepo(local)
  })

  afterEach(() => {
    fs.rmSync(remote, {force: true, recursive: true})
    fs.rmSync(local, {force: true, recursive: true})
    fs.rmSync(producer, {force: true, recursive: true})
  })

  it('returns kind=clean when local and remote diverge on different files', async () => {
    // Local commits b.json on top of base.
    await commitFile(local, 'b.json', '{"local":true}\n', 'local-only')

    // Producer commits c.json on top of base, pushes.
    await commitFile(producer, 'c.json', '{"remote":true}\n', 'remote-only')
    await git(producer, 'push', '-q', 'origin', 'main')

    // qfg pull --rebase: local's b.json should rebase cleanly on top of remote's c.json.
    const result = await gitPullRebase(local)
    expect(result.kind).to.equal('clean')
    if (result.kind === 'clean') {
      expect(result.commitsRebased).to.equal(1)
    }

    // Working tree contains both files.
    expect(fs.existsSync(path.join(local, 'b.json'))).to.equal(true)
    expect(fs.existsSync(path.join(local, 'c.json'))).to.equal(true)

    // No rebase-in-progress.
    expect(fs.existsSync(path.join(local, '.git', 'rebase-merge'))).to.equal(false)
    expect(fs.existsSync(path.join(local, '.git', 'rebase-apply'))).to.equal(false)
  })

  it('returns kind=conflicts with conflicted files when same field edited on both sides', async () => {
    // Local edits a.json default to "cli-vA".
    await commitFile(local, 'a.json', '{"v":"cli-vA"}\n', 'local-edit')

    // Producer edits same field, pushes.
    await commitFile(producer, 'a.json', '{"v":"ui-vADMIN"}\n', 'remote-edit')
    await git(producer, 'push', '-q', 'origin', 'main')

    const result = await gitPullRebase(local)
    expect(result.kind).to.equal('conflicts')
    if (result.kind === 'conflicts') {
      expect(result.conflictedFiles).to.deep.equal(['a.json'])
    }

    // Working tree has conflict markers planted by git.
    const content = fs.readFileSync(path.join(local, 'a.json'), 'utf8')
    expect(content).to.include('HEAD')
    expect(content.split('\n').some((l) => l.startsWith('======='))).to.equal(true)

    // Repo is in rebase-in-progress state — git rebase --continue / --abort apply.
    expect(fs.existsSync(path.join(local, '.git', 'rebase-merge'))).to.equal(true)
  })

  it('returns kind=failed when working tree has uncommitted changes blocking rebase', async () => {
    // Producer pushes an update; local has a dirty (uncommitted) change to the same file.
    await commitFile(producer, 'a.json', '{"v":"remote-update"}\n', 'remote-update')
    await git(producer, 'push', '-q', 'origin', 'main')

    fs.writeFileSync(path.join(local, 'a.json'), '{"v":"dirty"}\n')

    const result = await gitPullRebase(local)
    expect(result.kind).to.equal('failed')
    if (result.kind === 'failed') {
      expect(result.reason).to.be.a('string')
      expect(result.reason.length).to.be.greaterThan(0)
    }
  })
})
