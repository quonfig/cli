import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {PushConflictError, PushHookRejectedError, cloneAndStackPush} from '../../src/util/clone-and-stack-push.js'

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim()
}

function createBareRemote(rootTmp: string): string {
  const remoteDir = fs.mkdtempSync(path.join(rootTmp, 'remote-'))
  run(remoteDir, 'init', '--bare', '--initial-branch=main')
  return remoteDir
}

function seedRemoteWithInitialCommit(remoteDir: string, rootTmp: string): void {
  const seed = fs.mkdtempSync(path.join(rootTmp, 'seed-'))
  run(seed, 'init', '--initial-branch=main')
  run(seed, 'config', 'user.email', 'seed@test')
  run(seed, 'config', 'user.name', 'Seed')
  fs.writeFileSync(path.join(seed, 'README.md'), '# workspace\n')
  run(seed, 'add', '.')
  run(seed, 'commit', '-m', 'initial')
  run(seed, 'remote', 'add', 'origin', remoteDir)
  run(seed, 'push', 'origin', 'main')
}

function addUiCommit(remoteDir: string, rootTmp: string, file: string, content: string): void {
  const tmp = fs.mkdtempSync(path.join(rootTmp, 'ui-'))
  run(tmp, 'clone', remoteDir, '.')
  run(tmp, 'config', 'user.email', 'ui@test')
  run(tmp, 'config', 'user.name', 'UI Editor')
  const full = path.join(tmp, file)
  fs.mkdirSync(path.dirname(full), {recursive: true})
  fs.writeFileSync(full, content)
  run(tmp, 'add', '.')
  run(tmp, 'commit', '-m', 'ui edit')
  run(tmp, 'push', 'origin', 'main')
}

function cloneForRead(remoteDir: string, rootTmp: string): string {
  const tmp = fs.mkdtempSync(path.join(rootTmp, 'read-'))
  run(tmp, 'clone', remoteDir, '.')
  return tmp
}

function logSubjects(dir: string): string[] {
  return run(dir, 'log', '--pretty=format:%s').split('\n').filter(Boolean)
}

describe('cloneAndStackPush', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-strategy-'))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('clones, applies delta, and pushes when local dir does not exist', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    const result = await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'migrator: import delta',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-a.json'), '{"key":"a"}\n')
          },
        },
      ],
    })

    expect(result.committed).to.equal(true)
    expect(result.action).to.equal('cloned')

    const reader = cloneForRead(remote, root)
    expect(fs.existsSync(path.join(reader, 'flag-a.json'))).to.equal(true)
    expect(logSubjects(reader)).to.deep.equal(['migrator: import delta', 'initial'])
  })

  it('reuses an existing local clone, fetches UI edits, stacks delta on top, and ff-pushes', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    // First run: seed the local clone via the strategy
    await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'migrator: run 1',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-a.json'), '{"key":"a","v":1}\n')
          },
        },
      ],
    })

    // Simulate a UI edit on the remote on a different file
    addUiCommit(remote, root, 'flag-b.json', '{"key":"b","editedBy":"ui"}\n')

    // Second run: local is already a clone, should fetch + ff-merge the UI commit, then stack the delta
    const result = await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'migrator: run 2',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-a.json'), '{"key":"a","v":2}\n')
          },
        },
      ],
    })

    expect(result.committed).to.equal(true)
    expect(result.action).to.equal('reused')

    const reader = cloneForRead(remote, root)
    expect(logSubjects(reader)).to.deep.equal(['migrator: run 2', 'ui edit', 'migrator: run 1', 'initial'])
    // UI-edited flag survives untouched
    expect(fs.readFileSync(path.join(reader, 'flag-b.json'), 'utf8')).to.equal('{"key":"b","editedBy":"ui"}\n')
    // Migrator flag is the newer version
    expect(fs.readFileSync(path.join(reader, 'flag-a.json'), 'utf8')).to.equal('{"key":"a","v":2}\n')
  })

  it('commits with the migrator identity and lets committer be overridden', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'migrator: identity',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'x.json'), '{}\n')
          },
        },
      ],
    })

    const reader = cloneForRead(remote, root)
    const authorName = run(reader, 'log', '-1', '--pretty=format:%an')
    const authorEmail = run(reader, 'log', '-1', '--pretty=format:%ae')
    expect(authorName).to.equal('quonfig migrator')
    expect(authorEmail).to.equal('migrator@quonfig.com')
  })

  it('returns committed:false and does not create an empty commit when apply writes no changes', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    const result = await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'migrator: should not land',
          async apply() {
            // no files written
          },
        },
      ],
    })

    expect(result.committed).to.equal(false)
    expect(result.commitShas).to.have.length(0)

    const reader = cloneForRead(remote, root)
    expect(logSubjects(reader)).to.deep.equal(['initial'])
  })

  it('surfaces a PushHookRejectedError (not a fast-forward conflict) when the remote pre-receive hook declines the push', async function () {
    // The pre-receive hook execution path involves a real `git push` to a bare
    // remote with a custom hook installed. Under CPU contention from sibling
    // tests this can exceed the default 10s budget; give it explicit headroom.
    this.timeout(20_000)
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)

    // Install a pre-receive hook on the bare remote that always rejects, with output that
    // mimics qfg-verify's failure shape so we can assert the validation framing flows through.
    const hookPath = path.join(remote, 'hooks', 'pre-receive')
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\necho "qfg-verify: validating refs/heads/main" 1>&2\necho "FAILED: 2 error(s), 0 warning(s)" 1>&2\nexit 1\n',
    )
    fs.chmodSync(hookPath, 0o755)

    const localDir = path.join(root, 'workspace')

    let caught: Error | null = null
    try {
      await cloneAndStackPush({
        remoteUrl: remote,
        localDir,
        commits: [
          {
            message: 'migrator: bad data',
            async apply(dir) {
              fs.writeFileSync(path.join(dir, 'flag-a.json'), '{"v":1}\n')
            },
          },
        ],
      })
    } catch (error) {
      caught = error as Error
    }

    expect(caught, 'expected push to fail when hook rejects').to.be.instanceOf(PushHookRejectedError)
    // Misleading framing must NOT appear — that sends the user down the fast-forward debug path.
    expect(caught!.message).to.not.match(/remote has changes we do not have locally/i)
    expect(caught!.message).to.not.match(/re-run the migrator to pick up those changes/i)
    // The hook output must still surface so the user sees the real failure.
    expect(caught!.message).to.match(/FAILED: 2 error\(s\)/)
    // And the new framing should mention the hook/validation rejection.
    expect(caught!.message).to.match(/hook|validation/i)
  })

  it('pushes N commits with per-commit author, date, and message (qfg-wbkj)', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    const result = await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'create flag-x off',
          author: {name: 'Ada Lovelace', email: 'ada@example.com'},
          authorDate: new Date(1000),
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-x.json'), '{"v":false}\n')
          },
        },
        {
          message: 'flip flag-x on',
          author: {name: 'Grace Hopper', email: 'grace@example.com'},
          authorDate: new Date(2000),
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-x.json'), '{"v":true}\n')
          },
        },
        {
          message: 'flip flag-x off',
          author: {name: 'Linus T', email: 'linus@example.com'},
          authorDate: new Date(3000),
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-x.json'), '{"v":false}\n')
          },
        },
      ],
    })

    expect(result.committed).to.equal(true)
    expect(result.commitShas).to.have.length(3)
    expect(result.commitSha).to.equal(result.commitShas[2])

    const reader = cloneForRead(remote, root)
    expect(logSubjects(reader)).to.deep.equal(['flip flag-x off', 'flip flag-x on', 'create flag-x off', 'initial'])

    const readField = (ref: string, field: string): string => run(reader, 'log', '-1', `--pretty=format:${field}`, ref)

    expect(readField('HEAD~2', '%an')).to.equal('Ada Lovelace')
    expect(readField('HEAD~2', '%ae')).to.equal('ada@example.com')
    expect(new Date(readField('HEAD~2', '%aI')).getTime()).to.equal(1000)

    expect(readField('HEAD~1', '%an')).to.equal('Grace Hopper')
    expect(readField('HEAD~1', '%ae')).to.equal('grace@example.com')
    expect(new Date(readField('HEAD~1', '%aI')).getTime()).to.equal(2000)

    expect(readField('HEAD', '%an')).to.equal('Linus T')
    expect(readField('HEAD', '%ae')).to.equal('linus@example.com')
    expect(new Date(readField('HEAD', '%aI')).getTime()).to.equal(3000)
  })

  it('skips empty commits in a multi-commit batch without aborting', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    const result = await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'first real',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'a.json'), '{"v":1}\n')
          },
        },
        {
          message: 'no-op',
          async apply() {
            // Apply nothing
          },
        },
        {
          message: 'second real',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'b.json'), '{"v":2}\n')
          },
        },
      ],
    })

    expect(result.committed).to.equal(true)
    expect(result.commitShas).to.have.length(2)

    const reader = cloneForRead(remote, root)
    expect(logSubjects(reader)).to.deep.equal(['second real', 'first real', 'initial'])
  })

  it('surfaces a PushConflictError and does NOT force-push when the remote has moved between fetch and push', async () => {
    const remote = createBareRemote(root)
    seedRemoteWithInitialCommit(remote, root)
    const localDir = path.join(root, 'workspace')

    const result = await cloneAndStackPush({
      remoteUrl: remote,
      localDir,
      commits: [
        {
          message: 'migrator: run 1',
          async apply(dir) {
            fs.writeFileSync(path.join(dir, 'flag-a.json'), '{"v":1}\n')
          },
        },
      ],
    })
    expect(result.committed).to.equal(true)

    // Simulate a race: after our local fetch but before our push, another commit lands on the remote.
    // We implement this by racing apply: we add a UI commit *inside* apply so that the
    // local clone is stale at push time.
    let conflict: PushConflictError | null = null
    try {
      await cloneAndStackPush({
        remoteUrl: remote,
        localDir,
        commits: [
          {
            message: 'migrator: run 2 (will race)',
            async apply(dir) {
              // Simulate another writer pushing after we've already fetched+ff-merged
              addUiCommit(remote, root, 'flag-b.json', '{"v":"ui"}\n')
              fs.writeFileSync(path.join(dir, 'flag-a.json'), '{"v":2}\n')
            },
          },
        ],
      })
    } catch (error) {
      conflict = error as PushConflictError
    }

    expect(conflict, 'expected push to fail with PushConflictError').to.be.instanceOf(PushConflictError)

    // Remote history must still have the UI commit on top (no force-push clobbered it)
    const reader = cloneForRead(remote, root)
    const subjects = logSubjects(reader)
    expect(subjects[0]).to.equal('ui edit')
    expect(subjects).to.not.include('migrator: run 2 (will race)')
  })
})
