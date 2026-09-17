/**
 * `qfg workspace bootstrap` lands a local repo's history on a FRESH workspace
 * repo without ever force-pushing (plan
 * project/plans/2026-09-17-tree-derived-cache.md, 5.6 "Bootstrap keeps its
 * history without force", section 7, 13.2 risks 4 and 5).
 *
 * The remotes here mimic what provisioning really creates: a bare repo with an
 * auto-init `README.md` commit AND a second commit adding `quonfig.json`
 * (`workspace-provisioning.server.ts:155`) — the shape that makes a
 * commit-count freshness test wrong (13.2 risk 5). Every remote sets
 * `receive.denyNonFastForwards` so a force-push (or any rewrite) fails the test
 * rather than passing it.
 */

import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {gitFetch, gitSetRemote, rebaseOntoOriginAndPush, workspaceDocumentsAtRef} from '../../src/util/git-ops.js'

const SEED_IDENTITY = {
  GIT_AUTHOR_NAME: 'Quonfig Provisioner',
  GIT_AUTHOR_EMAIL: 'provisioner@quonfig.test',
  GIT_COMMITTER_NAME: 'Quonfig Provisioner',
  GIT_COMMITTER_EMAIL: 'provisioner@quonfig.test',
}

const CUSTOMER_IDENTITY = {
  GIT_AUTHOR_NAME: 'Local Customer',
  GIT_AUTHOR_EMAIL: 'customer@example.test',
  GIT_COMMITTER_NAME: 'Local Customer',
  GIT_COMMITTER_EMAIL: 'customer@example.test',
}

const REMOTE_PIN = '{"workspace":"test-org/hosted-ws","environments":["production","staging"]}\n'

/**
 * Every setup call is shielded from the developer's own git config — a machine
 * with `commit.gpgsign=true` globally must still be able to run this suite.
 * The code under test does its own shielding; that is what the "customer git
 * config" case below asserts.
 */
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'rerere.enabled=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {...process.env, ...env},
    },
  ).trim()
}

/** The git-only cases do not care about document validity; that has its own case. */
const rebasePush = (dir: string, opts: {validate?: boolean} = {}) =>
  rebaseOntoOriginAndPush(dir, {validate: false, ...opts})

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function mkDirIn(parent: string, name: string): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir, {recursive: true})
  return dir
}

function write(dir: string, file: string, contents: string): void {
  const full = path.join(dir, file)
  fs.mkdirSync(path.dirname(full), {recursive: true})
  fs.writeFileSync(full, contents)
}

/** A valid feature flag document, optionally with a per-environment override. */
function flagDoc(key: string, envIds: string[] = []): string {
  return (
    JSON.stringify(
      {
        key,
        type: 'feature_flag',
        valueType: 'bool',
        default: {rules: [{criteria: [], value: {type: 'bool', value: false}}]},
        environments: envIds.map((id) => ({id, rules: []})),
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * A bare workspace repo exactly as provisioning leaves it: auto-init README
 * commit, then the `quonfig.json` pin commit. Non-fast-forward pushes are
 * refused, which is what makes "no force" an assertion and not a claim.
 */
function provisionRemote(root: string, extraFiles: Record<string, string> = {}): string {
  const remote = path.join(root, 'workspace.git')
  git(root, ['init', '--bare', '--initial-branch=main', remote])
  git(remote, ['config', 'receive.denyNonFastForwards', 'true'])

  const seed = mkDirIn(root, 'seed')
  git(seed, ['init', '--initial-branch=main'])
  write(seed, 'README.md', '# hosted workspace\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'Initial commit'], SEED_IDENTITY)
  write(seed, 'quonfig.json', REMOTE_PIN)
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'chore: add quonfig.json'], SEED_IDENTITY)
  for (const [file, contents] of Object.entries(extraFiles)) {
    write(seed, file, contents)
  }
  if (Object.keys(extraFiles).length > 0) {
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'ui edit'], SEED_IDENTITY)
  }
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', 'origin', 'main'])
  return remote
}

/** A local repo the customer has been running open-source / datadir style. */
function localRepo(root: string): string {
  const dir = mkDirIn(root, 'local')
  git(dir, ['init', '--initial-branch=main'])
  git(dir, ['config', 'rerere.enabled', 'false'])
  return dir
}

function commitAll(dir: string, message: string, env: Record<string, string> = {}): void {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', message], {...CUSTOMER_IDENTITY, ...env})
}

function readRemoteFile(remote: string, file: string): string {
  return execFileSync('git', ['-C', remote, 'show', `main:${file}`], {encoding: 'utf8'})
}

function remoteSubjects(remote: string): string[] {
  return git(remote, ['log', '--pretty=format:%s', 'main']).split('\n').filter(Boolean)
}

/** Tree diff of the pushed tip against the customer's local tip. */
function diffAgainstLocal(dir: string, remote: string): string[] {
  const remoteTip = git(remote, ['rev-parse', 'main'])
  return git(dir, ['diff', '--no-renames', '--name-status', 'HEAD', remoteTip]).split('\n').filter(Boolean)
}

async function failureOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  throw new Error('expected the call to fail, but it succeeded')
}

describe('bootstrap: rebase onto origin and push (no force)', () => {
  let root: string

  beforeEach(() => {
    root = mkTmp('qfg-bootstrap-test-')
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('lands the local history with its authors and dates, without force', async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'add flag a', {GIT_AUTHOR_DATE: '2024-01-02T03:04:05-05:00'})
    write(dir, 'feature-flags/b.json', '{"key":"b"}\n')
    commitAll(dir, 'add flag b', {GIT_AUTHOR_DATE: '2024-03-04T05:06:07-05:00'})

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const result = await rebasePush(dir)

    expect(result.commitsRebased).to.equal(2)
    expect(result.pushedSha).to.have.length(40)

    // The seeded history is still underneath — a force-push would have replaced it.
    expect(remoteSubjects(remote)).to.deep.equal([
      'add flag b',
      'add flag a',
      'chore: add quonfig.json',
      'Initial commit',
    ])

    const landed = git(remote, ['log', '--pretty=format:%s|%an|%ad', '--date=short', '-2', 'main']).split('\n')
    expect(landed).to.deep.equal(['add flag b|Local Customer|2024-03-04', 'add flag a|Local Customer|2024-01-02'])
  })

  it('pushes a tree equal to the local tree except for files the remote seeded', async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'README.md', '# my local config\n')
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    write(dir, 'configs/nested/deep.json', '{"key":"deep"}\n')
    commitAll(dir, 'local config')

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    await rebasePush(dir)

    // Only the remote-seeded quonfig.json is extra; README collides and the
    // LOCAL copy wins.
    expect(diffAgainstLocal(dir, remote)).to.deep.equal(['A\tquonfig.json'])
    expect(readRemoteFile(remote, 'README.md')).to.equal('# my local config\n')
    expect(readRemoteFile(remote, 'feature-flags/a.json')).to.equal('{"key":"a"}\n')
    expect(readRemoteFile(remote, 'configs/nested/deep.json')).to.equal('{"key":"deep"}\n')
  })

  it("keeps the remote's seeded quonfig.json and says so honestly in the commit subject", async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'quonfig.json', '{"workspace":"someone-else/old-local","environments":["production"]}\n')
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config with its own pin')

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const result = await rebasePush(dir)

    expect(readRemoteFile(remote, 'quonfig.json')).to.equal(REMOTE_PIN)
    // Nothing was "reconciled": the only difference is the workspace's own pin.
    expect(result.reconcileSubject).to.equal("use the hosted workspace's quonfig.json")
    expect(remoteSubjects(remote)[0]).to.equal("use the hosted workspace's quonfig.json")
    // Everything else is the customer's content, plus the seeded README the
    // local repo never had.
    expect(diffAgainstLocal(dir, remote)).to.deep.equal(['A\tREADME.md', 'M\tquonfig.json'])
  })

  it('reconciles a hand-resolved merge conflict so the pushed tree equals the local tree', async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'feature-flags/x.json', '{"key":"x","v":"base"}\n')
    commitAll(dir, 'base')
    git(dir, ['checkout', '-b', 'side'])
    write(dir, 'feature-flags/x.json', '{"key":"x","v":"side"}\n')
    commitAll(dir, 'side edit')
    git(dir, ['checkout', 'main'])
    write(dir, 'feature-flags/x.json', '{"key":"x","v":"main"}\n')
    commitAll(dir, 'main edit')
    try {
      git(dir, ['merge', 'side'])
    } catch {
      /* expected conflict, resolved by hand below */
    }
    write(dir, 'feature-flags/x.json', '{"key":"x","v":"hand-resolved"}\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '--no-edit', '-m', 'merge side (hand resolved)'], CUSTOMER_IDENTITY)

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const result = await rebasePush(dir)

    // Without the reconcile commit the linearised history would ship
    // `"side"` — exit 0 and the wrong content (13.2 risk 4).
    expect(readRemoteFile(remote, 'feature-flags/x.json')).to.equal('{"key":"x","v":"hand-resolved"}\n')
    expect(result.reconcileSubject).to.equal('reconcile merge resolutions')
    expect(remoteSubjects(remote)[0]).to.equal('reconcile merge resolutions')
    expect(diffAgainstLocal(dir, remote)).to.deep.equal(['A\tREADME.md', 'A\tquonfig.json'])
    // The seeded README the local repo never had is still there.
    expect(readRemoteFile(remote, 'README.md')).to.equal('# hosted workspace\n')
  })

  it("leaves the customer's local main untouched on success", async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')
    const before = git(dir, ['rev-parse', 'main'])

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    await rebasePush(dir)

    expect(git(dir, ['rev-parse', 'main'])).to.equal(before)
    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).to.equal('main')
    expect(git(dir, ['status', '--porcelain'])).to.equal('')
    // No temporary worktree left behind.
    expect(git(dir, ['worktree', 'list']).split('\n')).to.have.length(1)
  })

  it("pushes nothing and leaves the customer's local main untouched when the push is rejected", async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')
    const localBefore = git(dir, ['rev-parse', 'main'])

    await gitSetRemote(dir, remote)
    await gitFetch(dir)

    // Someone else lands a commit between our fetch and our push: the plain
    // push is no longer a fast-forward, and nothing rewrites it.
    const other = mkDirIn(root, 'other')
    git(other, ['clone', remote, '.'])
    write(other, 'notes.md', 'hello\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-m', 'someone else'], SEED_IDENTITY)
    git(other, ['push', 'origin', 'main'])
    const remoteBefore = git(remote, ['rev-parse', 'main'])

    await failureOf(() => rebasePush(dir))

    expect(git(dir, ['rev-parse', 'main'])).to.equal(localBefore)
    expect(git(remote, ['rev-parse', 'main'])).to.equal(remoteBefore)
    expect(git(dir, ['worktree', 'list']).split('\n')).to.have.length(1)
  })

  it('refuses a workspace repo that has no main branch instead of creating one', async () => {
    const remote = path.join(root, 'empty.git')
    git(root, ['init', '--bare', '--initial-branch=main', remote])
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')

    await gitSetRemote(dir, remote)
    await gitFetch(dir)

    // The pre-receive hook rejects a zero-oid create of `main` (plan 5.6 item
    // 1), so "push it into existence" is not a fallback, it is a dead end.
    const message = await failureOf(() => rebasePush(dir))
    expect(message).to.match(/not provisioned/i)
    expect(git(remote, ['branch', '--list'])).to.equal('')
  })

  it('aborts a failed rebase cleanly and points at `qfg push` to land the content', async () => {
    // A file/directory collision is a conflict `-X theirs` cannot resolve (a
    // modify/delete is another): the workspace seeded a FILE named `notes`,
    // the local repo has a DIRECTORY of that name.
    const remote = provisionRemote(root, {notes: 'hosted note\n'})
    const dir = localRepo(root)
    write(dir, 'notes/a.md', 'local note\n')
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')
    const localBefore = git(dir, ['rev-parse', 'main'])

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const remoteBefore = git(remote, ['rev-parse', 'main'])

    const message = await failureOf(() => rebasePush(dir))

    expect(message).to.contain(`qfg push --dir ${dir}`)
    expect(git(remote, ['rev-parse', 'main'])).to.equal(remoteBefore)
    expect(git(dir, ['rev-parse', 'main'])).to.equal(localBefore)
    expect(git(dir, ['status', '--porcelain'])).to.equal('')
    expect(git(dir, ['worktree', 'list']).split('\n')).to.have.length(1)
  })

  it("is not broken by the customer's commit hooks or gpg signing config", async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    // A local pin, so the reconcile commit runs too — both the rebase and the
    // commit have to be shielded.
    write(dir, 'quonfig.json', '{"workspace":"someone-else/old-local","environments":["production"]}\n')
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')

    const hooks = mkDirIn(root, 'hooks')
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "customer hook says no" >&2\nexit 1\n', {
      mode: 0o755,
    })
    git(dir, ['config', 'core.hooksPath', hooks])
    git(dir, ['config', 'commit.gpgsign', 'true'])
    git(dir, ['config', 'tag.gpgsign', 'true'])
    git(dir, ['config', 'gpg.program', path.join(root, 'no-such-gpg')])

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const result = await rebasePush(dir)

    expect(result.reconcileSubject).to.equal("use the hosted workspace's quonfig.json")
    expect(readRemoteFile(remote, 'feature-flags/a.json')).to.equal('{"key":"a"}\n')
    expect(readRemoteFile(remote, 'quonfig.json')).to.equal(REMOTE_PIN)
  })

  it('validates the tree it is about to push, not the local one', async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    // Valid locally: the local quonfig.json declares `local-only`. Not valid on
    // the workspace: its own quonfig.json wins and declares production/staging,
    // so the override would be rejected by the server hook after the push.
    write(dir, 'quonfig.json', '{"workspace":"someone-else/old-local","environments":["production","local-only"]}\n')
    write(dir, 'feature-flags/a.json', flagDoc('a', ['local-only']))
    commitAll(dir, 'local config')

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const remoteBefore = git(remote, ['rev-parse', 'main'])

    const message = await failureOf(() => rebasePush(dir, {validate: true}))

    expect(message).to.contain('local-only')
    expect(message).to.match(/nothing was pushed/i)
    expect(git(remote, ['rev-parse', 'main'])).to.equal(remoteBefore)
    expect(git(dir, ['worktree', 'list']).split('\n')).to.have.length(1)
  })

  it('pushes a tree the workspace hook would accept', async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'quonfig.json', '{"workspace":"someone-else/old-local","environments":["production"]}\n')
    write(dir, 'feature-flags/a.json', flagDoc('a', ['production']))
    commitAll(dir, 'local config')

    await gitSetRemote(dir, remote)
    await gitFetch(dir)
    const result = await rebasePush(dir, {validate: true})

    expect(result.pushedSha).to.have.length(40)
    expect(readRemoteFile(remote, 'feature-flags/a.json')).to.equal(flagDoc('a', ['production']))
  })
})

describe('bootstrap: a workspace is fresh only when it holds no documents', () => {
  let root: string

  beforeEach(() => {
    root = mkTmp('qfg-bootstrap-fresh-')
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('treats a really provisioned repo (README + quonfig.json) as fresh', async () => {
    const remote = provisionRemote(root)
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')
    await gitSetRemote(dir, remote)
    await gitFetch(dir)

    expect(await workspaceDocumentsAtRef(dir, 'origin/main')).to.deep.equal([])
  })

  it('counts schemas and schemas-protected, not just config documents', async () => {
    // A UI-authored schema is content a local-wins rebase would silently
    // overwrite, so it makes the workspace non-fresh just like a flag does.
    const remote = provisionRemote(root, {
      'configs/db.url.json': '{"key":"db.url"}\n',
      'feature-flags/live.json': '{"key":"live"}\n',
      'schemas-protected/locked.json': '{"key":"locked"}\n',
      'schemas/thing.json': '{"key":"thing"}\n',
    })
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')
    await gitSetRemote(dir, remote)
    await gitFetch(dir)

    expect(await workspaceDocumentsAtRef(dir, 'origin/main')).to.deep.equal([
      'configs/db.url.json',
      'feature-flags/live.json',
      'schemas-protected/locked.json',
      'schemas/thing.json',
    ])
  })

  it('fails closed when the ref cannot be listed', async () => {
    const dir = localRepo(root)
    write(dir, 'feature-flags/a.json', '{"key":"a"}\n')
    commitAll(dir, 'local config')

    // "I could not look" must never read as "the workspace is empty" — that
    // would let bootstrap land a local history under live documents.
    await failureOf(() => workspaceDocumentsAtRef(dir, 'origin/main'))
  })
})

describe('bootstrap: nothing can force-push any more', () => {
  it('git-ops exports no force-push helper', async () => {
    const gitOps = await import('../../src/util/git-ops.js')
    expect(Object.keys(gitOps)).to.not.include('gitPushForce')
    expect(Object.keys(gitOps)).to.not.include('gitPushForceLease')
  })
})
