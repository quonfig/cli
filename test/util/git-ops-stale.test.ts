import {expect} from 'chai'
import {execFile as execFileCb} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as util from 'node:util'

import {isLocalBehindOrDivergedFromRemote} from '../../src/util/git-ops.js'

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

describe('isLocalBehindOrDivergedFromRemote (qfg-fboj)', () => {
  let remote: string
  let local: string

  beforeEach(async () => {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-remote-'))
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-local-'))
    await execFile('git', ['init', '-q', '--bare', '-b', 'main', remote])
  })

  afterEach(() => {
    fs.rmSync(remote, {force: true, recursive: true})
    fs.rmSync(local, {force: true, recursive: true})
  })

  it('returns false when local HEAD == origin/main', async () => {
    await execFile('git', ['clone', '-q', remote, local])
    await initRepo(local)
    await commitFile(local, 'a.json', '{"v":1}', 'initial')
    await git(local, 'push', '-q', 'origin', 'main')
    await git(local, 'fetch', '-q', 'origin')

    const result = await isLocalBehindOrDivergedFromRemote(local)
    expect(result).to.equal(false)
  })

  it('returns false when local is strictly ahead of origin/main', async () => {
    await execFile('git', ['clone', '-q', remote, local])
    await initRepo(local)
    await commitFile(local, 'a.json', '{"v":1}', 'initial')
    await git(local, 'push', '-q', 'origin', 'main')
    await commitFile(local, 'a.json', '{"v":2}', 'local-only')
    await git(local, 'fetch', '-q', 'origin')

    const result = await isLocalBehindOrDivergedFromRemote(local)
    expect(result).to.equal(false)
  })

  it('returns true when local HEAD is strictly behind origin/main (Persona-C scenario)', async () => {
    // Bootstrap: seed remote with two commits via a producer clone.
    const producer = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-producer-'))
    try {
      await execFile('git', ['clone', '-q', remote, producer])
      await initRepo(producer)
      await commitFile(producer, 'a.json', '{"v":1}', 'one')
      await git(producer, 'push', '-q', 'origin', 'main')

      // Local clones at HEAD = commit one.
      await execFile('git', ['clone', '-q', remote, local])

      // Producer adds commit two, pushes to remote — local is now stale.
      await commitFile(producer, 'a.json', '{"v":2}', 'two')
      await git(producer, 'push', '-q', 'origin', 'main')

      // Local fetches (so origin/main ref updates) but does not pull.
      await git(local, 'fetch', '-q', 'origin')

      const result = await isLocalBehindOrDivergedFromRemote(local)
      expect(result).to.equal(true)
    } finally {
      fs.rmSync(producer, {force: true, recursive: true})
    }
  })

  it('returns true when local has diverged from origin/main (both have commits the other lacks)', async () => {
    // Bootstrap shared base via producer.
    const producer = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-producer-'))
    try {
      await execFile('git', ['clone', '-q', remote, producer])
      await initRepo(producer)
      await commitFile(producer, 'a.json', '{"v":1}', 'base')
      await git(producer, 'push', '-q', 'origin', 'main')

      await execFile('git', ['clone', '-q', remote, local])

      // Local commits something on top of base.
      await commitFile(local, 'b.json', '{"local":true}', 'local-only')

      // Producer commits something different on top of base and pushes.
      await commitFile(producer, 'c.json', '{"remote":true}', 'remote-only')
      await git(producer, 'push', '-q', 'origin', 'main')

      // Local fetches; now diverged.
      await git(local, 'fetch', '-q', 'origin')

      const result = await isLocalBehindOrDivergedFromRemote(local)
      expect(result).to.equal(true)
    } finally {
      fs.rmSync(producer, {force: true, recursive: true})
    }
  })

  it('returns false on a non-git directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-nogit-'))
    try {
      const result = await isLocalBehindOrDivergedFromRemote(tmp)
      expect(result).to.equal(false)
    } finally {
      fs.rmSync(tmp, {force: true, recursive: true})
    }
  })

  it('returns false when origin/main ref is missing (never fetched)', async () => {
    await initRepo(local)
    await commitFile(local, 'a.json', '{"v":1}', 'init')
    // Note: no remote configured, no fetch — origin/main does not exist.
    const result = await isLocalBehindOrDivergedFromRemote(local)
    expect(result).to.equal(false)
  })
})
