import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {computeBarePathDiff} from '../../src/push/bare-path-diff.js'

/**
 * Integration-lite coverage for the bare-path diff helper that backs
 * `buildRealDeps`'s `diffHeadVsOrigin` / `countFilesInRemote` when the
 * local dir is NOT a git clone.
 *
 * We stand up a real bare git repo in tmp, seed it with a few files, then
 * point the helper at a separate local directory and verify it reports the
 * correct added / modified / deleted deltas plus remote file count.
 */

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function createBareRemote(rootTmp: string): string {
  const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
  run(remoteDir, 'init', '--bare', '--initial-branch=main')
  return remoteDir
}

function seedRemoteWith(remoteDir: string, rootTmp: string, files: Record<string, string>): void {
  const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
  run(seed, 'init', '--initial-branch=main')
  run(seed, 'config', 'user.email', 'seed@test')
  run(seed, 'config', 'user.name', 'Seed')
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(seed, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, content)
  }

  run(seed, 'add', '.')
  run(seed, 'commit', '-m', 'seed')
  run(seed, 'remote', 'add', 'origin', remoteDir)
  run(seed, 'push', 'origin', 'main')
}

function writeLocal(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, content)
  }
}

describe('computeBarePathDiff (bare-path real deps)', () => {
  let root: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bare-diff-')))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('reports no deltas when local matches remote exactly', async () => {
    const remote = createBareRemote(root)
    seedRemoteWith(remote, root, {
      'configs/one.json': '{"k":1}\n',
      'quonfig.json': '{"environments":["production"]}\n',
    })

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    writeLocal(local, {
      'configs/one.json': '{"k":1}\n',
      'quonfig.json': '{"environments":["production"]}\n',
    })

    const result = await computeBarePathDiff(local, remote)
    try {
      expect(result.deltas).to.deep.equal([])
      expect(result.totalRemoteFiles).to.equal(2)
    } finally {
      fs.rmSync(result.scratchDir, {force: true, recursive: true})
    }
  })

  it('detects added, modified, and deleted files', async () => {
    const remote = createBareRemote(root)
    seedRemoteWith(remote, root, {
      'configs/keep.json': '{"v":1}\n',
      'configs/change.json': '{"v":1}\n',
      'configs/gone.json': '{"v":1}\n',
    })

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    writeLocal(local, {
      'configs/keep.json': '{"v":1}\n',
      'configs/change.json': '{"v":2}\n', // modified
      'configs/new.json': '{"v":1}\n', // added
      // configs/gone.json intentionally missing -> deleted
    })

    const result = await computeBarePathDiff(local, remote)
    try {
      const byKind = (kind: 'added' | 'deleted' | 'modified') =>
        result.deltas
          .filter((d: {kind: string; path: string}) => d.kind === kind)
          .map((d: {path: string}) => d.path)
          .sort()

      expect(byKind('added')).to.deep.equal(['configs/new.json'])
      expect(byKind('modified')).to.deep.equal(['configs/change.json'])
      expect(byKind('deleted')).to.deep.equal(['configs/gone.json'])
      expect(result.totalRemoteFiles).to.equal(3)
    } finally {
      fs.rmSync(result.scratchDir, {force: true, recursive: true})
    }
  })

  it('ignores dotfiles/dotdirs (e.g. .git, .DS_Store) on both sides', async () => {
    const remote = createBareRemote(root)
    seedRemoteWith(remote, root, {
      'configs/a.json': '{"a":1}\n',
    })

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    writeLocal(local, {
      'configs/a.json': '{"a":1}\n',
      '.DS_Store': 'macos-garbage',
      '.quonfig-cache/stuff.txt': 'noise',
    })

    const result = await computeBarePathDiff(local, remote)
    try {
      expect(result.deltas).to.deep.equal([])
      // totalRemoteFiles: only configs/a.json counts (the scratch clone's .git/
      // must be excluded).
      expect(result.totalRemoteFiles).to.equal(1)
    } finally {
      fs.rmSync(result.scratchDir, {force: true, recursive: true})
    }
  })

  it('exposes the probe clone HEAD sha as remoteHeadSha (qfg-nhcb optimistic lock)', async () => {
    const remote = createBareRemote(root)
    seedRemoteWith(remote, root, {'configs/a.json': '{"a":1}\n'})

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    writeLocal(local, {'configs/a.json': '{"a":1}\n'})

    const result = await computeBarePathDiff(local, remote)
    try {
      // remoteHeadSha is what `qfg push` forwards as `expectedSha`; it must
      // be the cloud repo's main tip, not an empty/undefined value.
      expect(result.remoteHeadSha).to.match(/^[\da-f]{40}$/)
      expect(result.remoteHeadSha).to.equal(run(remote, 'rev-parse', 'main'))
    } finally {
      fs.rmSync(result.scratchDir, {force: true, recursive: true})
    }
  })

  it('returns a scratchDir the caller can clean up', async () => {
    const remote = createBareRemote(root)
    seedRemoteWith(remote, root, {'configs/a.json': '{"a":1}\n'})

    const local = fs.mkdtempSync(path.join(root, 'local-'))
    writeLocal(local, {'configs/a.json': '{"a":1}\n'})

    const result = await computeBarePathDiff(local, remote)
    expect(fs.existsSync(result.scratchDir)).to.equal(true)
    expect(fs.existsSync(path.join(result.scratchDir, '.git'))).to.equal(true)
    fs.rmSync(result.scratchDir, {force: true, recursive: true})
    expect(fs.existsSync(result.scratchDir)).to.equal(false)
  })
})
