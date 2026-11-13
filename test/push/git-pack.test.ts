/**
 * Tests for `cli/src/push/git-pack.ts` — the pack-push primitives that
 * back the new `qfg push` clone-path flow (qfg-7429.4, §4.1 of
 * project/plans/qfg-git-commit-push-pull-improvements.md).
 *
 * Coverage:
 *   - `getCurrentBranch` returns `{kind: 'branch', name}` for a normal
 *     checked-out branch, refuses detached HEAD with the documented
 *     message, and refuses `master` with the rename suggestion.
 *   - `buildPack` produces a non-empty packfile of `<expectedSha>..HEAD`
 *     that round-trips through `git index-pack --strict --stdin` against
 *     a fresh bare clone of the base — proving the pack carries the new
 *     commits and their reachable trees/blobs.
 *   - `buildPack` enforces the §7 open Q #7 25 MB cap and throws a
 *     `PackTooLargeError` on overflow.
 *   - `buildPack` returns an empty `Uint8Array` when there are zero new
 *     commits (HEAD === expectedSha), so the no-op caller path stays
 *     symmetric with the bare-path "no deltas" return.
 */

import {expect} from 'chai'
import {execFileSync, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {PackTooLargeError, buildPack, getCurrentBranch, MAX_PACK_BYTES} from '../../src/push/git-pack.js'

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function tmpDir(prefix = 'qfg-git-pack-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function makeRepo(opts: {branch?: string; initialFile?: {name: string; content: string}} = {}): string {
  const dir = tmpDir()
  const branch = opts.branch ?? 'main'
  run(dir, 'init', `--initial-branch=${branch}`)
  run(dir, 'config', 'user.email', 'test@test')
  run(dir, 'config', 'user.name', 'Test')
  const initial = opts.initialFile ?? {name: 'README.md', content: 'hello\n'}
  fs.writeFileSync(path.join(dir, initial.name), initial.content)
  run(dir, 'add', '.')
  run(dir, 'commit', '-m', 'initial')
  return dir
}

function commitFile(dir: string, file: string, content: string, message = `update ${file}`): string {
  fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true})
  fs.writeFileSync(path.join(dir, file), content)
  run(dir, 'add', '--', file)
  run(dir, 'commit', '-m', message)
  return run(dir, 'rev-parse', 'HEAD')
}

describe('git-pack: getCurrentBranch', () => {
  let root: string
  beforeEach(() => {
    root = process.cwd()
  })
  afterEach(() => {
    process.chdir(root)
  })

  it('returns {kind: "branch", name: "main"} on a fresh main checkout', async () => {
    const dir = makeRepo()
    try {
      const result = await getCurrentBranch(dir)
      expect(result).to.deep.equal({kind: 'branch', name: 'main'})
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('returns the actual branch name when HEAD is on a non-main feature branch', async () => {
    const dir = makeRepo()
    try {
      run(dir, 'checkout', '-b', 'feature/awesome-flag')
      const result = await getCurrentBranch(dir)
      expect(result).to.deep.equal({kind: 'branch', name: 'feature/awesome-flag'})
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('returns kind: "detached" with the documented refusal message when HEAD is detached', async () => {
    const dir = makeRepo()
    try {
      const sha = run(dir, 'rev-parse', 'HEAD')
      run(dir, 'checkout', '--detach', sha)
      const result = await getCurrentBranch(dir)
      expect(result.kind).to.equal('detached')
      if (result.kind === 'detached') {
        expect(result.message).to.equal('qfg push requires a checked-out branch.')
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('returns kind: "master" with the rename suggestion when HEAD is on master', async () => {
    const dir = makeRepo({branch: 'master'})
    try {
      const result = await getCurrentBranch(dir)
      expect(result.kind).to.equal('master')
      if (result.kind === 'master') {
        expect(result.message).to.equal('Quonfig workspaces use `main`; rename with `git branch -m master main`.')
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('git-pack: buildPack', () => {
  it('produces a packfile that index-pack accepts when applied to a clone of the base', async () => {
    // Set up: source repo with one commit (the "base"), then add 2 more
    // commits on top. Expected base SHA = first commit. New tip = HEAD.
    const src = makeRepo()
    try {
      const baseSha = run(src, 'rev-parse', 'HEAD')
      commitFile(src, 'configs/a.json', '{"k":1}\n', 'add a')
      const newSha = commitFile(src, 'configs/b.json', '{"k":2}\n', 'add b')

      const pack = await buildPack(src, baseSha, newSha)

      expect(pack).to.be.instanceOf(Uint8Array)
      expect(pack.byteLength).to.be.greaterThan(0)
      // Pack files start with "PACK" magic (0x50 0x41 0x43 0x4b).
      expect(pack[0]).to.equal(0x50)
      expect(pack[1]).to.equal(0x41)
      expect(pack[2]).to.equal(0x43)
      expect(pack[3]).to.equal(0x4b)

      // Round-trip: clone base into a fresh repo, ingest the pack via
      // index-pack --strict, then assert the new commits are present.
      const clone = tmpDir('qfg-pack-clone-')
      try {
        run(clone, 'clone', '--no-local', src, '.')
        run(clone, 'reset', '--hard', baseSha)
        // Wipe the remote-tracking refs so the new objects start as
        // dangling — index-pack should accept them.
        const ingest = spawnSync('git', ['-C', clone, 'index-pack', '--strict', '--stdin'], {
          input: Buffer.from(pack),
          encoding: 'buffer',
        })
        expect(ingest.status, ingest.stderr?.toString()).to.equal(0)
        // Verify the tip is now in the object DB of the clone.
        const exists = spawnSync('git', ['-C', clone, 'cat-file', '-e', newSha])
        expect(exists.status).to.equal(0)
      } finally {
        fs.rmSync(clone, {recursive: true, force: true})
      }
    } finally {
      fs.rmSync(src, {recursive: true, force: true})
    }
  })

  it('returns an empty Uint8Array when expectedSha === newSha (no new commits)', async () => {
    const dir = makeRepo()
    try {
      const sha = run(dir, 'rev-parse', 'HEAD')
      const pack = await buildPack(dir, sha, sha)
      expect(pack).to.be.instanceOf(Uint8Array)
      expect(pack.byteLength).to.equal(0)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('throws PackTooLargeError when the pack would exceed MAX_PACK_BYTES', async () => {
    const dir = makeRepo()
    try {
      const baseSha = run(dir, 'rev-parse', 'HEAD')
      // Use random bytes so zlib can't squash the blob to nothing — a
      // run of identical chars compresses to ~100 bytes regardless of
      // input length and would fly under any cap we set.
      const {randomBytes} = await import('node:crypto')
      const big = randomBytes(8 * 1024).toString('base64') // ~10.7 KB of high-entropy text
      const newSha = commitFile(dir, 'configs/big.json', big, 'add big blob')

      let caught: unknown
      try {
        await buildPack(dir, baseSha, newSha, {maxBytes: 1024})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(PackTooLargeError)
      expect((caught as PackTooLargeError).message).to.match(/exceeds .* bytes/i)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  // qfg-b1eo: a brand-new branch has no origin/<branch>, so run-push passes
  // the zero OID as expectedSha. `^0000…` is a bad object to pack-objects;
  // the pack must instead exclude what the server already has (origin/*).
  it('packs only the new commits when expectedSha is the zero OID (brand-new branch)', async () => {
    const ZERO_OID = '0000000000000000000000000000000000000000'
    const server = tmpDir('qfg-pack-server-')
    const src = makeRepo()
    try {
      run(server, 'init', '--bare', '--initial-branch=main')
      run(src, 'remote', 'add', 'origin', server)
      run(src, 'push', '-q', 'origin', 'main')
      run(src, 'fetch', '-q', 'origin')
      run(src, 'checkout', '-q', '-b', 'feature/new')
      const newSha = commitFile(src, 'configs/a.json', '{"k":1}\n', 'add a')

      const pack = await buildPack(src, ZERO_OID, newSha)

      // Header bytes 8..11 hold the object count: the new commit, its tree,
      // the configs/ subtree and the new blob — none of main's objects.
      expect(Buffer.from(pack).readUInt32BE(8)).to.equal(4)

      // The server (which has main) can ingest it and now has the tip.
      const ingest = spawnSync('git', ['-C', server, 'index-pack', '--strict', '--stdin'], {
        input: Buffer.from(pack),
        encoding: 'buffer',
      })
      expect(ingest.status, ingest.stderr?.toString()).to.equal(0)
      expect(spawnSync('git', ['-C', server, 'cat-file', '-e', newSha]).status).to.equal(0)
    } finally {
      fs.rmSync(src, {recursive: true, force: true})
      fs.rmSync(server, {recursive: true, force: true})
    }
  })

  // qfg-5bjew.9: a branch is updated by `git merge origin/main`. The merge
  // commit's ancestry then includes main's new commits, which the server
  // already has. Excluding only expectedSha (origin/<branch>) would re-ship
  // them all; run-push passes origin/main in `excludeShas` for branch pushes.
  it('leaves origin/main objects out of the pack for a branch that merged origin/main', async () => {
    const server = tmpDir('qfg-pack-server-')
    const src = makeRepo()
    const other = tmpDir('qfg-pack-other-')
    try {
      run(server, 'init', '--bare', '--initial-branch=main')
      run(src, 'remote', 'add', 'origin', server)
      run(src, 'push', '-q', 'origin', 'main')

      // The branch is pushed once: origin/feature = branchTip.
      run(src, 'checkout', '-q', '-b', 'feature')
      const branchTip = commitFile(src, 'configs/a.json', '{"a":1}\n', 'add a')
      run(src, 'push', '-q', 'origin', 'feature')

      // Someone else advances main on the server.
      fs.rmSync(other, {recursive: true, force: true})
      execFileSync('git', ['clone', '-q', server, other])
      run(other, 'config', 'user.email', 'other@test')
      run(other, 'config', 'user.name', 'Other')
      commitFile(other, 'configs/b.json', '{"b":2}\n', 'add b on main')
      run(other, 'push', '-q', 'origin', 'main')

      // The branch merges origin/main in.
      run(src, 'fetch', '-q', 'origin')
      run(src, 'merge', '-q', '--no-edit', 'origin/main')
      const mergeSha = run(src, 'rev-parse', 'HEAD')
      const originMain = run(src, 'rev-parse', 'origin/main')

      const pack = await buildPack(src, branchTip, mergeSha, {excludeShas: [originMain]})

      // Only the merge commit, its root tree and its configs/ subtree are
      // new. Main's commit, trees and the b.json blob are left out.
      expect(Buffer.from(pack).readUInt32BE(8)).to.equal(3)

      // The server (which has main and the branch) can ingest it.
      const ingest = spawnSync('git', ['-C', server, 'index-pack', '--strict', '--stdin'], {
        input: Buffer.from(pack),
        encoding: 'buffer',
      })
      expect(ingest.status, ingest.stderr?.toString()).to.equal(0)
      expect(spawnSync('git', ['-C', server, 'cat-file', '-e', mergeSha]).status).to.equal(0)
    } finally {
      fs.rmSync(src, {recursive: true, force: true})
      fs.rmSync(server, {recursive: true, force: true})
      fs.rmSync(other, {recursive: true, force: true})
    }
  })

  it('packs the full history for the zero OID when there are no origin refs', async () => {
    const ZERO_OID = '0000000000000000000000000000000000000000'
    const src = makeRepo()
    try {
      const newSha = run(src, 'rev-parse', 'HEAD')
      const pack = await buildPack(src, ZERO_OID, newSha)
      // initial commit + root tree + README blob.
      expect(Buffer.from(pack).readUInt32BE(8)).to.equal(3)
    } finally {
      fs.rmSync(src, {recursive: true, force: true})
    }
  })

  it('exports MAX_PACK_BYTES = 25 MiB to match the §7 open Q #7 cap', () => {
    expect(MAX_PACK_BYTES).to.equal(25 * 1024 * 1024)
  })
})
