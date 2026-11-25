/**
 * The shallow workspace snapshot a secret write reads quonfig.json, the
 * existing document and the lock SHA from (plan section 0, bead qfg-mol-hle
 * PR 2). Runs against a file:// bare repo.
 */
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

import {
  SnapshotPathError,
  cloneWorkspaceSnapshot,
  openWorkspaceSnapshot,
  withWorkspaceSnapshot,
} from '../../src/secrets/workspace-snapshot.js'
import {streamGitNulEntries} from '../../src/util/git-ops.js'
import {bareWorkspaceRepo, configDoc, git, quonfigJson, tmpDir} from './plumbing-fixtures.js'

/** Every file under `dir`, as text (binary files decode lossily, which is fine for a substring search). */
function allText(dir: string): string {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(allText(p))
    else if (entry.isFile()) out.push(fs.readFileSync(p, 'latin1'))
  }

  return out.join('\n')
}

describe('workspace snapshot (qfg-mol-hle)', function () {
  this.timeout(30_000) // a few git processes per test; slow on windows-latest
  let root: string
  let bare: string
  let headSha: string
  let url: string
  const MARKER = 'repo-url-marker-7f3a'

  beforeEach(() => {
    root = tmpDir('qfg-snap-test-')
    ;({bare, headSha} = bareWorkspaceRepo(path.join(root, MARKER), {
      'configs/Stripe.Key.json': configDoc('Stripe.Key'),
      'quonfig.json': quonfigJson({}),
      'configs/.hidden.json': '{}',
      'secrets/.keep': '',
    }))
    url = pathToFileURL(bare).href
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, maxRetries: 3, recursive: true})
  })

  it('clones main shallowly and reports its HEAD sha as the lock', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(snap.headSha).to.equal(headSha)
      expect(git(snap.dir, 'rev-parse', '--is-shallow-repository')).to.equal('true')
      expect(git(snap.dir, 'rev-parse', 'HEAD')).to.equal(headSha)
      expect(snap.readFile('quonfig.json')).to.equal(quonfigJson({}))
      expect(snap.readFile('secrets/missing.json')).to.equal(undefined)
      expect(snap.listJson('configs'), 'dotfiles are not documents').to.deep.equal(['Stripe.Key.json'])
      expect(snap.listJson('secrets')).to.deep.equal([])
      expect(snap.listJson('no-such-dir')).to.deep.equal([])
      expect(snap.hasSecrets()).to.equal(false)
    } finally {
      await snap.cleanup()
    }
  })

  it('leaves no trace of the repo URL (where a token lives) in the clone', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(allText(path.join(snap.dir, '.git'))).to.not.include(MARKER)
      expect(git(snap.dir, 'config', '--local', '--list')).to.not.include(MARKER)
      expect(git(snap.dir, 'remote')).to.equal('')
    } finally {
      await snap.cleanup()
    }
  })

  it('finds a key in any family case-insensitively', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(snap.findKey('stripe.key')).to.deep.equal([
        {dir: 'configs', file: 'configs/Stripe.Key.json', key: 'Stripe.Key'},
      ])
      expect(snap.findKey('other')).to.deep.equal([])
    } finally {
      await snap.cleanup()
    }
  })

  it('documents() returns every top-level file of the validated directories', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect([...snap.documents().keys()].sort()).to.deep.equal([
        'configs/.hidden.json',
        'configs/Stripe.Key.json',
        'secrets/.keep',
      ])
    } finally {
      await snap.cleanup()
    }
  })

  it('readFile matches the letter case of the path exactly, even on a case-insensitive filesystem', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(snap.readFile('configs/Stripe.Key.json')).to.equal(configDoc('Stripe.Key'))
      expect(snap.readFile('configs/stripe.key.json'), 'a case variant is a different file').to.equal(undefined)
      expect(snap.readFile('CONFIGS/Stripe.Key.json')).to.equal(undefined)
      expect(snap.listJson('Configs')).to.deep.equal([])
    } finally {
      await snap.cleanup()
    }
  })

  it('readFile and listJson refuse paths outside the clone', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      for (const bad of [
        '../x.json',
        '/etc/passwd',
        'configs/../../x',
        'configs/../secrets/x.json',
        '.git/config',
        './.git/config',
        './/.git/HEAD',
        'configs//../.git/config',
        '.GIT/config',
        '.Git/HEAD',
        '.git',
        '.\\.git\\config',
        'a\\..\\b',
        'C:/x.json',
        '',
        '.',
      ]) {
        expect(() => snap.readFile(bad), bad).to.throw(/outside the workspace snapshot/)
      }

      expect(() => snap.listJson('..')).to.throw(/outside the workspace snapshot/)
      expect(() => snap.listJson('./.GIT')).to.throw(SnapshotPathError)
    } finally {
      await snap.cleanup()
    }
  })

  it('cleanup removes the temp directory', async () => {
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    expect(fs.existsSync(snap.dir)).to.equal(true)
    await snap.cleanup()
    expect(fs.existsSync(snap.dir)).to.equal(false)
  })

  it('withWorkspaceSnapshot removes the temp directory when the callback throws', async () => {
    let seen = ''
    let caught: unknown
    try {
      await withWorkspaceSnapshot(
        url,
        async (snap) => {
          seen = snap.dir
          throw new Error('boom')
        },
        {tmpRoot: root},
      )
    } catch (error) {
      caught = error
    }

    expect((caught as Error).message).to.equal('boom')
    expect(seen).to.not.equal('')
    expect(fs.existsSync(seen)).to.equal(false)
  })

  it('withWorkspaceSnapshot removes the temp directory on success', async () => {
    const dir = await withWorkspaceSnapshot(url, async (snap) => snap.dir, {tmpRoot: root})
    expect(fs.existsSync(dir)).to.equal(false)
  })

  it('a failed clone removes its temp directory and never shows the token', async () => {
    const before = fs.readdirSync(root)
    let caught: unknown
    try {
      await cloneWorkspaceSnapshot('https://qfg:SENTINELTOKEN123@127.0.0.1:1/acme/ws.git', {tmpRoot: root})
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect(String((caught as Error).message)).to.not.include('SENTINELTOKEN123')
    expect(String((caught as {stderr?: string}).stderr ?? '')).to.not.include('SENTINELTOKEN123')
    expect(fs.readdirSync(root)).to.deep.equal(before)
  })

  it('a repo with no main branch is an error, and the temp directory is removed', async () => {
    const other = path.join(root, 'other')
    fs.mkdirSync(other)
    git(other, 'init', '-q', '--bare')
    const before = fs.readdirSync(root)
    let caught: unknown
    try {
      await cloneWorkspaceSnapshot(pathToFileURL(other).href, {tmpRoot: root})
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect(fs.readdirSync(root)).to.deep.equal(before)
  })
})

describe('openWorkspaceSnapshot credentials (qfg-mol-hle)', () => {
  const ws = {orgSlug: 'acme', workspaceId: '00000000-0000-4000-8000-000000000001'}
  const fakeSnapshot = (repoUrl: string) => ({repoUrl}) as never

  it('uses a stored, unexpired read token', async () => {
    const urls: string[] = []
    const r = await openWorkspaceSnapshot(undefined, {
      async clone(u) {
        urls.push(u)
        return fakeSnapshot(u)
      },
      loadToken: async () => ({expiresAt: null, repoUrl: 'https://u:t1@g/x.git', token: 't1'}),
      mintToken: async () => expect.fail('must not mint'),
      resolveWorkspace: async () => ws,
    })
    expect(urls).to.deep.equal(['https://u:t1@g/x.git'])
    expect(r).to.deep.include(ws)
  })

  it('mints when no token is stored, and re-mints once on a 401', async () => {
    const urls: string[] = []
    let mints = 0
    await openWorkspaceSnapshot('acme/prod', {
      async clone(u) {
        urls.push(u)
        if (urls.length === 1) throw new Error('fatal: Authentication failed (401)')
        return fakeSnapshot(u)
      },
      loadToken: async () => null,
      async mintToken() {
        mints++
        return {expiresAt: null, repoUrl: `https://u:t${mints}@g/x.git`, token: `t${mints}`}
      },
      async resolveWorkspace(w) {
        expect(w).to.equal('acme/prod')
        return ws
      },
    })
    expect(mints).to.equal(2)
    expect(urls).to.deep.equal(['https://u:t1@g/x.git', 'https://u:t2@g/x.git'])
  })

  it('a non-401 clone error is not retried', async () => {
    let clones = 0
    let caught: unknown
    try {
      await openWorkspaceSnapshot(undefined, {
        async clone() {
          clones++
          throw new Error('network down')
        },
        loadToken: async () => ({expiresAt: null, repoUrl: 'https://u:t@g/x.git', token: 't'}),
        mintToken: async () => expect.fail('must not mint'),
        resolveWorkspace: async () => ws,
      })
    } catch (error) {
      caught = error
    }

    expect((caught as Error).message).to.equal('network down')
    expect(clones).to.equal(1)
  })
})

describe('workspace snapshot never reads outside the clone through symlinks (qfg-mol-hle)', function () {
  this.timeout(30_000)
  let root: string
  let outsideDir: string
  let outsideFile: string
  const SENTINEL = 'OUTSIDE-LOCAL-CONTENT-5c1e'

  beforeEach(() => {
    root = tmpDir('qfg-snap-symlink-test-')
    outsideDir = path.join(root, 'outside')
    fs.mkdirSync(outsideDir)
    outsideFile = path.join(outsideDir, 'x.json')
    fs.writeFileSync(outsideFile, JSON.stringify({key: 'x', sentinel: SENTINEL}))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, maxRetries: 3, recursive: true})
  })

  const snapshotOf = async (files: Record<string, string>, symlinks: Record<string, string>) => {
    const {bare} = bareWorkspaceRepo(path.join(root, 'repo'), files, {symlinks})
    return cloneWorkspaceSnapshot(pathToFileURL(bare).href, {tmpRoot: root})
  }

  /** Everything the snapshot will hand out, as one string. */
  const everything = (snap: Awaited<ReturnType<typeof snapshotOf>>) => {
    const out: string[] = []
    const attempt = (fn: () => unknown) => {
      try {
        out.push(JSON.stringify(fn()))
      } catch (error) {
        expect(error, String(error)).to.be.instanceOf(SnapshotPathError)
      }
    }

    attempt(() => [...snap.documents()])
    for (const d of ['configs', 'secrets']) attempt(() => snap.listJson(d))
    for (const f of ['quonfig.json', 'configs/x.json', 'secrets/x.json']) attempt(() => snap.readFile(f))
    return out.join('\n')
  }

  it('a symlinked quonfig.json and a symlinked family directory are refused, not followed', async () => {
    const snap = await snapshotOf({'secrets/ok.json': '{}'}, {configs: outsideDir, 'quonfig.json': outsideFile})
    try {
      expect(() => snap.readFile('quonfig.json')).to.throw(SnapshotPathError, /symlink/)
      expect(() => snap.readFile('configs/x.json')).to.throw(SnapshotPathError, /symlink/)
      expect(() => snap.listJson('configs')).to.throw(SnapshotPathError)
      expect(() => snap.documents(), 'a symlinked family directory fails the whole read').to.throw(SnapshotPathError)
      expect(everything(snap)).to.not.include(SENTINEL)
      // Nothing is checked out: no file, link or not, exists in the snapshot dir.
      expect(fs.existsSync(path.join(snap.dir, 'quonfig.json'))).to.equal(false)
      expect(fs.existsSync(path.join(snap.dir, 'configs'))).to.equal(false)
    } finally {
      await snap.cleanup()
    }
  })

  it('a symlinked secrets/ directory is refused', async () => {
    const snap = await snapshotOf({'quonfig.json': '{}'}, {secrets: outsideDir})
    try {
      expect(() => snap.readFile('secrets/x.json')).to.throw(SnapshotPathError)
      expect(() => snap.hasSecrets()).to.throw(SnapshotPathError)
      expect(everything(snap)).to.not.include(SENTINEL)
    } finally {
      await snap.cleanup()
    }
  })

  it('a symlinked document inside secrets/ is refused and left out of listings', async () => {
    const snap = await snapshotOf({'secrets/ok.json': '{"ok":1}'}, {'secrets/x.json': outsideFile})
    try {
      expect(() => snap.readFile('secrets/x.json')).to.throw(SnapshotPathError, /symlink/)
      expect(snap.listJson('secrets')).to.deep.equal(['ok.json'])
      expect([...snap.documents().keys()]).to.deep.equal(['secrets/ok.json'])
      expect(snap.findKey('x')).to.deep.equal([])
      expect(everything(snap)).to.not.include(SENTINEL)
      expect(fs.existsSync(path.join(snap.dir, 'secrets'))).to.equal(false)
    } finally {
      await snap.cleanup()
    }
  })

  // Nothing is read from the working tree, so a link planted in the snapshot
  // dir after the fetch changes nothing (qfg-mol-hle PR 3a, D1).
  const posix = process.platform === 'win32' ? it.skip : it
  posix('a symlink planted in the snapshot directory is never read', async () => {
    const {bare} = bareWorkspaceRepo(path.join(root, 'repo'), {'quonfig.json': '{}', 'secrets/ok.json': '{}'})
    const snap = await cloneWorkspaceSnapshot(pathToFileURL(bare).href, {tmpRoot: root})
    try {
      fs.symlinkSync(outsideFile, path.join(snap.dir, 'quonfig.json'))
      fs.symlinkSync(outsideDir, path.join(snap.dir, 'secrets'))
      expect(snap.readFile('quonfig.json')).to.equal('{}')
      expect(snap.listJson('secrets')).to.deep.equal(['ok.json'])
      expect(everything(snap)).to.not.include(SENTINEL)
    } finally {
      await snap.cleanup()
    }
  })
})

describe('workspace snapshot branch rule (qfg-mol-hle)', function () {
  this.timeout(30_000)
  let root: string
  beforeEach(() => {
    root = tmpDir('qfg-snap-branch-test-')
  })
  afterEach(() => {
    fs.rmSync(root, {force: true, maxRetries: 3, recursive: true})
  })

  it('snapshots main even when the remote HEAD names another branch', async () => {
    const {bare} = bareWorkspaceRepo(root, {'quonfig.json': '{"branch":"trunk"}'}, {branch: 'trunk'})
    const work = path.join(root, 'work')
    git(work, 'checkout', '-q', '-b', 'main')
    fs.writeFileSync(path.join(work, 'quonfig.json'), '{"branch":"main"}')
    git(work, 'commit', '-q', '-am', 'main')
    git(work, 'push', '-q', bare, 'main')
    const mainSha = git(work, 'rev-parse', 'HEAD')
    const snap = await cloneWorkspaceSnapshot(pathToFileURL(bare).href, {tmpRoot: root})
    try {
      expect(snap.headSha).to.equal(mainSha)
      expect(snap.readFile('quonfig.json')).to.equal('{"branch":"main"}')
    } finally {
      await snap.cleanup()
    }
  })

  it('a repo with only another branch is an error, and nothing is left behind', async () => {
    const {bare} = bareWorkspaceRepo(root, {'quonfig.json': '{}'}, {branch: 'trunk'})
    const before = fs.readdirSync(root)
    let caught: unknown
    try {
      await cloneWorkspaceSnapshot(pathToFileURL(bare).href, {tmpRoot: root})
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect(fs.readdirSync(root)).to.deep.equal(before)
  })
})

describe('workspace snapshot of a large workspace (qfg-mol-hle PR 3, carry-in S1)', function () {
  this.timeout(180_000) // 15,000 files are checked out; slow on windows-latest
  let root: string

  afterEach(() => fs.rmSync(root, {force: true, maxRetries: 3, recursive: true}))

  /**
   * A bare repo whose main holds quonfig.json and `count` files, built with
   * plumbing (one shared blob, `update-index --index-info`, `write-tree`,
   * `commit-tree`) so no file is written to build it. `git ls-tree -r` of
   * this tree is well over Node's default 1 MiB child-process output limit.
   */
  function largeRepo(count: number): {bare: string; headSha: string} {
    const bare = path.join(root, 'large.git')
    git(root, 'init', '-q', '--bare', bare)
    const blob = execFileSync('git', ['-C', bare, 'hash-object', '-w', '--stdin'], {encoding: 'utf8', input: '{}\n'})
      .toString()
      .trim()
    const manifest = execFileSync('git', ['-C', bare, 'hash-object', '-w', '--stdin'], {
      encoding: 'utf8',
      input: quonfigJson({}),
    }).trim()
    const lines = [`100644 ${manifest}\tquonfig.json`]
    for (let i = 0; i < count; i++) {
      lines.push(
        `100644 ${blob}\tassets/a-fairly-long-asset-file-name-to-fill-the-listing-${String(i).padStart(6, '0')}.json`,
      )
    }

    const env = {...process.env, GIT_INDEX_FILE: path.join(root, 'large.index')}
    execFileSync('git', ['-C', bare, 'update-index', '--index-info'], {env, input: `${lines.join('\n')}\n`})
    const tree = execFileSync('git', ['-C', bare, 'write-tree'], {encoding: 'utf8', env}).trim()
    const commit = git(root, '-C', bare, 'commit-tree', tree, '-m', 'large')
    git(root, '-C', bare, 'update-ref', 'refs/heads/main', commit)
    return {bare, headSha: commit}
  }

  it('snapshots a workspace of 15,000 files (git ls-tree output above 1 MiB)', async () => {
    root = tmpDir('qfg-snap-large-')
    const {bare, headSha} = largeRepo(15_000)
    const listing = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '-z', 'main'], {maxBuffer: 64 * 1024 * 1024})
    expect(listing.length, 'the fixture must exceed the default 1 MiB limit').to.be.greaterThan(1024 * 1024)
    const snap = await cloneWorkspaceSnapshot(pathToFileURL(bare).href, {tmpRoot: root})
    try {
      expect(snap.headSha).to.equal(headSha)
      expect(snap.readFile('quonfig.json')).to.equal(quonfigJson({}))
    } finally {
      await snap.cleanup()
    }
  })
})

describe('workspace snapshot reads git objects, not a checkout (qfg-mol-hle PR 3a, D1)', function () {
  this.timeout(60_000)
  let root: string

  beforeEach(() => {
    root = tmpDir('qfg-snap-objects-')
  })
  afterEach(() => fs.rmSync(root, {force: true, maxRetries: 3, recursive: true}))

  /**
   * A bare repo whose main holds `files` (path -> text) and `gitlinks` (path ->
   * commit sha), built with plumbing and core.ignorecase=false, so trees with
   * case-variant paths can be built on any file system.
   */
  function plumbingRepo(files: Record<string, string>, gitlinks: Record<string, string> = {}): string {
    const bare = path.join(root, 'ws.git')
    git(root, 'init', '-q', '--bare', bare)
    const lines: string[] = []
    for (const [p, text] of Object.entries(files)) {
      const oid = execFileSync('git', ['-C', bare, 'hash-object', '-w', '--stdin'], {
        encoding: 'utf8',
        input: text,
      }).trim()
      lines.push(`100644 ${oid}\t${p}`)
    }

    for (const [p, sha] of Object.entries(gitlinks)) lines.push(`160000 ${sha}\t${p}`)
    const env = {...process.env, GIT_INDEX_FILE: path.join(root, 'ws.index')}
    execFileSync('git', ['-c', 'core.ignorecase=false', '-C', bare, 'update-index', '--index-info'], {
      env,
      input: `${lines.join('\n')}\n`,
    })
    const tree = execFileSync('git', ['-C', bare, 'write-tree'], {encoding: 'utf8', env}).trim()
    const commit = git(root, '-C', bare, 'commit-tree', tree, '-m', 'seed')
    git(root, '-C', bare, 'update-ref', 'refs/heads/main', commit)
    return pathToFileURL(bare).href
  }

  it('a case-variant top-level directory does not hide secrets/ (Secrets/ and secrets/ in one tree)', async () => {
    const url = plumbingRepo({
      'Secrets/zzz.json': '{"key":"zzz"}',
      'quonfig.json': quonfigJson({}),
      'secrets/db.json': '{"key":"db"}',
    })
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(snap.listJson('secrets')).to.deep.equal(['db.json'])
      expect(snap.readFile('secrets/db.json')).to.equal('{"key":"db"}')
      expect(snap.findKey('db')).to.deep.equal([{dir: 'secrets', file: 'secrets/db.json', key: 'db'}])
      expect(snap.hasSecrets()).to.equal(true)
      expect([...snap.documents().keys()]).to.deep.equal(['secrets/db.json'])
    } finally {
      await snap.cleanup()
    }
  })

  it('two files that differ only in case are two files', async () => {
    const url = plumbingRepo({
      'quonfig.json': quonfigJson({}),
      'secrets/DB.json': '{"key":"DB"}',
      'secrets/db.json': '{"key":"db"}',
    })
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(snap.listJson('secrets')).to.deep.equal(['DB.json', 'db.json'])
      expect(snap.readFile('secrets/DB.json')).to.equal('{"key":"DB"}')
      expect(snap.readFile('secrets/db.json')).to.equal('{"key":"db"}')
    } finally {
      await snap.cleanup()
    }
  })

  it('a submodule entry is not a file: reads through it are refused and listings leave it out', async () => {
    const url = plumbingRepo({'configs/a.json': '{}', 'quonfig.json': quonfigJson({})}, {'secrets/sub': 'a'.repeat(40)})
    const snap = await cloneWorkspaceSnapshot(url, {tmpRoot: root})
    try {
      expect(() => snap.readFile('secrets/sub')).to.throw(SnapshotPathError)
      expect(() => snap.readFile('secrets/sub/x.json')).to.throw(SnapshotPathError)
      expect(snap.listJson('secrets')).to.deep.equal([])
    } finally {
      await snap.cleanup()
    }
  })
})

describe('streamGitNulEntries (qfg-mol-hle PR 3a, N8)', function () {
  this.timeout(60_000)
  let root: string
  let bare: string

  before(() => {
    root = tmpDir('qfg-stream-')
    bare = path.join(root, 'r.git')
    git(root, 'init', '-q', '--bare', bare)
    const blob = execFileSync('git', ['-C', bare, 'hash-object', '-w', '--stdin'], {
      encoding: 'utf8',
      input: 'x',
    }).trim()
    const lines = Array.from({length: 5000}, (_, i) => `100644 ${blob}\tdir/entry-${String(i).padStart(5, '0')}.json`)
    const env = {...process.env, GIT_INDEX_FILE: path.join(root, 'r.index')}
    execFileSync('git', ['-C', bare, 'update-index', '--index-info'], {env, input: `${lines.join('\n')}\n`})
    const tree = execFileSync('git', ['-C', bare, 'write-tree'], {encoding: 'utf8', env}).trim()
    git(root, '-C', bare, 'update-ref', 'refs/heads/main', git(root, '-C', bare, 'commit-tree', tree, '-m', 's'))
  })
  after(() => fs.rmSync(root, {force: true, maxRetries: 3, recursive: true}))

  it('delivers every entry whole, even when entries are split across stdout chunks', async () => {
    const seen: string[] = []
    await streamGitNulEntries(['-C', bare, 'ls-tree', '-r', '-z', 'main'], (e) => seen.push(e))
    expect(seen).to.have.length(5000)
    expect(seen.every((e) => /^100644 blob [\da-f]{40}\tdir\/entry-\d{5}\.json$/.test(e))).to.equal(true)
  })

  it('rejects when onEntry throws, instead of an uncaught exception', async () => {
    const err = await streamGitNulEntries(['-C', bare, 'ls-tree', '-r', '-z', 'main'], () => {
      throw new Error('stop here')
    }).then(
      () => {},
      (error: Error) => error,
    )
    expect(err?.message).to.equal('stop here')
  })

  it('rejects on a non-zero exit, with tokens redacted', async () => {
    const err = await streamGitNulEntries(
      ['-C', bare, 'ls-tree', '-r', '-z', 'https://u:SENTINELTOKEN@example.invalid/x'],
      () => {},
    ).then(
      () => {},
      (error: Error) => error,
    )
    expect(err?.message).to.match(/failed \(exit \d+\)/)
    expect(err?.message).to.not.include('SENTINELTOKEN')
  })

  it('rejects on a timeout', async () => {
    const err = await streamGitNulEntries(['-C', bare, 'ls-tree', '-r', '-z', 'main'], () => {}, {timeoutMs: 1}).then(
      () => {},
      (error: Error) => error,
    )
    expect(err?.message).to.match(/timed out/)
  })
})
