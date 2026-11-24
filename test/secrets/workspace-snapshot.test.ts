/**
 * The shallow workspace snapshot a secret write reads quonfig.json, the
 * existing document and the lock SHA from (plan section 0, bead qfg-mol-hle
 * PR 2). Runs against a file:// bare repo.
 */
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

import {
  SnapshotPathError,
  cloneWorkspaceSnapshot,
  openWorkspaceSnapshot,
  withWorkspaceSnapshot,
} from '../../src/secrets/workspace-snapshot.js'
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
      // core.symlinks=false: what is on disk is a plain file, never a link.
      expect(fs.lstatSync(path.join(snap.dir, 'quonfig.json')).isSymbolicLink()).to.equal(false)
      expect(fs.lstatSync(path.join(snap.dir, 'configs')).isSymbolicLink()).to.equal(false)
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
      expect(fs.lstatSync(path.join(snap.dir, 'secrets', 'x.json')).isSymbolicLink()).to.equal(false)
    } finally {
      await snap.cleanup()
    }
  })

  // The lstat layer on its own: a link planted on disk after the checkout.
  // Creating symlinks needs privileges on Windows, so this runs on POSIX only.
  const posix = process.platform === 'win32' ? it.skip : it
  posix('an on-disk symlink file or parent directory in the clone is refused (lstat layer)', async () => {
    const {bare} = bareWorkspaceRepo(path.join(root, 'repo'), {'quonfig.json': '{}', 'secrets/ok.json': '{}'})
    const snap = await cloneWorkspaceSnapshot(pathToFileURL(bare).href, {tmpRoot: root})
    try {
      fs.rmSync(path.join(snap.dir, 'quonfig.json'))
      fs.symlinkSync(outsideFile, path.join(snap.dir, 'quonfig.json'))
      fs.rmSync(path.join(snap.dir, 'secrets'), {recursive: true})
      fs.symlinkSync(outsideDir, path.join(snap.dir, 'secrets'))
      expect(() => snap.readFile('quonfig.json')).to.throw(SnapshotPathError, /regular file/)
      expect(() => snap.readFile('secrets/x.json')).to.throw(SnapshotPathError, /regular/)
      expect(() => snap.listJson('secrets')).to.throw(SnapshotPathError)
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
