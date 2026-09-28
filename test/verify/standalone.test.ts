import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {readFilesFromCommit, runHookChecks} from '../../src/verify/standalone.js'
import {validateFileMap} from '../../src/verify/validate.js'

/**
 * qfg-6na9.6: the pre-receive hook must see EVERY file in the pushed tree.
 * The old implementation shelled out with string interpolation
 * (`git show ${oid}:${path}`) and parsed default `git ls-tree` output, so a
 * filename containing a space (word-splitting) or non-ASCII chars (git
 * C-quoting under core.quotePath) was silently skipped — which meant the
 * Policy A charset check never ran for exactly the keys most likely to
 * violate it. Verified live on staging 2026-07-03: a `configs/bad charset
 * key.json` push was ACCEPTED by the deployed hook.
 */
describe('standalone readFilesFromCommit', () => {
  function createGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-standalone-'))
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'})
    git('init', '--quiet')
    git('config', 'user.email', 'test@quonfig.test')
    git('config', 'user.name', 'test')
    return dir
  }

  function commitAll(dir: string): string {
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'})
    git('add', '-A')
    git('commit', '--quiet', '-m', 'fixture')
    return git('rev-parse', 'HEAD').trim()
  }

  function writeConfig(dir: string, relPath: string, key: string): void {
    fs.mkdirSync(path.join(dir, path.dirname(relPath)), {recursive: true})
    fs.writeFileSync(
      path.join(dir, relPath),
      JSON.stringify({
        key,
        type: 'config',
        valueType: 'string',
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'x'}}]},
        environments: [],
        variants: [],
      }),
    )
  }

  it('reads files whose names contain spaces (no shell word-splitting)', () => {
    const dir = createGitRepo()
    writeConfig(dir, 'configs/clean-key.json', 'clean-key')
    writeConfig(dir, 'configs/bad charset key.json', 'bad charset key')
    const oid = commitAll(dir)

    const files = readFilesFromCommit(oid, dir)
    expect([...files.keys()].sort()).to.deep.equal(['configs/bad charset key.json', 'configs/clean-key.json'])
  })

  it('reads files whose names contain non-ASCII chars (git quotePath must not hide them)', () => {
    const dir = createGitRepo()
    writeConfig(dir, 'configs/café.json', 'café')
    const oid = commitAll(dir)

    const files = readFilesFromCommit(oid, dir)
    expect([...files.keys()]).to.deep.equal(['configs/café.json'])
  })

  it('end-to-end: a space-key file in the tree is a hard validateFileMap error', () => {
    const dir = createGitRepo()
    writeConfig(dir, 'configs/bad charset key.json', 'bad charset key')
    const oid = commitAll(dir)

    const result = validateFileMap(readFilesFromCommit(oid, dir))
    expect(result.valid, JSON.stringify(result.issues)).to.be.false
    expect(result.issues.some((i) => i.severity === 'error' && /allowed set/i.test(i.message))).to.be.true
  })

  it('fails closed: an unreadable listed file throws instead of being silently skipped', () => {
    const dir = createGitRepo()
    writeConfig(dir, 'configs/clean-key.json', 'clean-key')
    commitAll(dir)

    // A bogus oid makes every git invocation fail — must throw, not return an empty map
    expect(() => readFilesFromCommit('0'.repeat(40), dir)).to.throw()
  })

  // qfg-hbuy.4: the hook must SEE every entry under the validated dirs.
  // Dotfiles, nested paths, and non-lowercase-.json files used to be filtered
  // out of the enumeration itself, so validateFileMap never got the chance to
  // reject them — ghost files that push fine but no loader ever reads.
  describe('ghost-file enumeration (qfg-hbuy.4)', () => {
    it('enumerates dotfiles, nested paths, and .JSON-cased files (no silent skip)', () => {
      const dir = createGitRepo()
      writeConfig(dir, 'configs/clean-key.json', 'clean-key')
      writeConfig(dir, 'configs/.evil.json', '.evil')
      writeConfig(dir, 'configs/sub/x.json', 'x')
      writeConfig(dir, 'configs/FOO.JSON', 'FOO')
      const oid = commitAll(dir)

      const files = readFilesFromCommit(oid, dir)
      expect([...files.keys()].sort()).to.deep.equal([
        'configs/.evil.json',
        'configs/FOO.JSON',
        'configs/clean-key.json',
        'configs/sub/x.json',
      ])
    })

    it('end-to-end: a committed dotfile is a hard validateFileMap error', () => {
      const dir = createGitRepo()
      writeConfig(dir, 'configs/.evil.json', '.evil')
      const oid = commitAll(dir)

      const result = validateFileMap(readFilesFromCommit(oid, dir))
      expect(result.valid, JSON.stringify(result.issues)).to.be.false
      expect(result.issues.some((i) => i.severity === 'error' && /dotfile/i.test(i.message))).to.be.true
    })

    it('end-to-end: a committed nested path is a hard validateFileMap error', () => {
      const dir = createGitRepo()
      writeConfig(dir, 'configs/sub/x.json', 'x')
      const oid = commitAll(dir)

      const result = validateFileMap(readFilesFromCommit(oid, dir))
      expect(result.valid, JSON.stringify(result.issues)).to.be.false
      expect(result.issues.some((i) => i.severity === 'error' && /subdirector/i.test(i.message))).to.be.true
    })

    it('end-to-end: a committed FOO.JSON is a hard validateFileMap error', () => {
      const dir = createGitRepo()
      writeConfig(dir, 'configs/FOO.JSON', 'FOO')
      const oid = commitAll(dir)

      const result = validateFileMap(readFilesFromCommit(oid, dir))
      expect(result.valid, JSON.stringify(result.issues)).to.be.false
      expect(result.issues.some((i) => i.severity === 'error' && /lowercase "\.json"/i.test(i.message))).to.be.true
    })

    it('end-to-end: .qf/, README.md, and quonfig.json pass through untouched', () => {
      const dir = createGitRepo()
      writeConfig(dir, 'configs/clean-key.json', 'clean-key')
      fs.mkdirSync(path.join(dir, '.qf'), {recursive: true})
      fs.writeFileSync(path.join(dir, '.qf', 'key-plan.json'), JSON.stringify({}))
      fs.writeFileSync(path.join(dir, 'README.md'), '# workspace')
      fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({environments: []}))
      const oid = commitAll(dir)

      const files = readFilesFromCommit(oid, dir)
      // The hook only enumerates the validated content dirs — root files and
      // the .qf/ bookkeeping dir are not its business.
      expect([...files.keys()]).to.deep.equal(['configs/clean-key.json'])

      const result = validateFileMap(files)
      expect(result.valid, JSON.stringify(result.issues)).to.be.true
    })
  })

  // qfg-3nyi: one `git show` per file made a 620-file push spend ~10s just
  // spawning processes. The tree must be read with a fixed number of git
  // processes, whatever its size.
  describe('batched reads (qfg-3nyi)', () => {
    function withGitShim<T>(fn: () => T): {calls: string[]; result: T} {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim()
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-git-shim-'))
      const log = path.join(shimDir, 'calls.log')
      fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${realGit}" "$@"\n`, {
        mode: 0o755,
      })
      const originalPath = process.env.PATH
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`
      try {
        const result = fn()
        const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
        return {calls, result}
      } finally {
        process.env.PATH = originalPath
      }
    }

    it('reads a 40-file tree with at most two git processes', () => {
      const dir = createGitRepo()
      for (let i = 0; i < 20; i++) writeConfig(dir, `configs/key-${i}.json`, `key-${i}`)
      for (let i = 0; i < 20; i++) writeConfig(dir, `segments/seg-${i}.json`, `seg-${i}`)
      const oid = commitAll(dir)

      const {calls, result: files} = withGitShim(() => readFilesFromCommit(oid, dir))
      expect(files.size).to.equal(40)
      expect(calls.length, calls.join(',')).to.be.at.most(2)
      // macOS scans a freshly written script on its first exec (~3s each).
    }).timeout(30_000)

    it('returns exact contents for multi-byte and identical files', () => {
      const dir = createGitRepo()
      const multiByte = '{"note": "café ☕ 日本語 🚀"}\n'
      fs.mkdirSync(path.join(dir, 'configs'), {recursive: true})
      fs.writeFileSync(path.join(dir, 'configs/a.json'), multiByte)
      fs.writeFileSync(path.join(dir, 'configs/b.json'), multiByte) // same blob oid as a.json
      fs.writeFileSync(path.join(dir, 'configs/c.json'), '')
      fs.writeFileSync(path.join(dir, 'configs/d.json'), '{"z": 1}')
      const oid = commitAll(dir)

      const files = readFilesFromCommit(oid, dir)
      expect(Object.fromEntries(files)).to.deep.equal({
        'configs/a.json': multiByte,
        'configs/b.json': multiByte,
        'configs/c.json': '',
        'configs/d.json': '{"z": 1}',
      })
    })

    it('fails closed: a gitlink (submodule) entry under a validated dir throws', () => {
      const dir = createGitRepo()
      writeConfig(dir, 'configs/clean-key.json', 'clean-key')
      const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'})
      git('add', '-A')
      git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},configs/sub`)
      git('commit', '--quiet', '-m', 'gitlink')
      const oid = git('rev-parse', 'HEAD').trim()

      expect(() => readFilesFromCommit(oid, dir)).to.throw(/configs\/sub/)
    })
  })
})

/**
 * qfg-q5f6.10 (plan 2026-09-25-advanced-schema-for-jev.md W1b, Decision 10):
 * the pre-receive hook enforces schema-bound JSON values and schema
 * compilation, exactly as the CLI and the app do. Each test drives the whole
 * hook decision (runHookChecks) against a real repo.
 */
describe('hook mode validates schema-bound values (qfg-q5f6.10)', () => {
  const RETRY_SCHEMA = {properties: {retries: {type: 'integer'}}, required: ['retries'], type: 'object'}

  function retryConfig(value: unknown): Record<string, unknown> {
    return {
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'json', value}}]},
      environments: [],
      key: 'retry-policy',
      schemaKey: 'retry',
      type: 'config',
      valueType: 'json',
      variants: [],
    }
  }

  function stringConfig(key: string, value: string): Record<string, unknown> {
    return {
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value}}]},
      environments: [],
      key,
      type: 'config',
      valueType: 'string',
      variants: [],
    }
  }

  let dir: string
  const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'}).trim()

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-hook-values-'))
    git('init', '--quiet', '--initial-branch', 'main')
    git('config', 'user.email', 'test@quonfig.test')
    git('config', 'user.name', 'test')
  })

  afterEach(() => {
    fs.rmSync(dir, {force: true, recursive: true})
  })

  function commitTree(files: Record<string, unknown>, message = 'fixture'): string {
    for (const [relPath, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, path.dirname(relPath)), {recursive: true})
      fs.writeFileSync(path.join(dir, relPath), JSON.stringify(content))
    }

    git('add', '-A')
    git('commit', '--quiet', '-m', message)
    return git('rev-parse', 'HEAD')
  }

  function runHook(newOid: string, oldOid = '0'.repeat(40)): {code: number; output: string} {
    const logs: string[] = []
    const code = runHookChecks([{newOid, oldOid, refName: 'refs/heads/main'}], {
      cwd: dir,
      env: {},
      log: (line) => logs.push(line),
      logErr: (line) => logs.push(line),
    })
    return {code, output: logs.join('\n')}
  }

  it('rejects a push whose json value violates its schema, naming the config and the violation', () => {
    const oid = commitTree({
      'configs/retry-policy.json': retryConfig({retries: 'three'}),
      'schemas/retry.json': RETRY_SCHEMA,
    })

    const {code, output} = runHook(oid)
    expect(code, output).to.equal(1)
    expect(output).to.include('configs/retry-policy.json:')
    expect(output).to.include(
      'ERROR: Value does not match schema "retry": default.rules[0].value.retries: must be integer',
    )
  })

  it('accepts a push whose json value matches its schema', () => {
    const oid = commitTree({
      'configs/retry-policy.json': retryConfig({retries: 3}),
      'schemas/retry.json': RETRY_SCHEMA,
    })

    const {code, output} = runHook(oid)
    expect(code, output).to.equal(0)
    expect(output).to.not.include('does not match schema')
  })

  it('rejects a push containing a schema that does not compile, even when nothing binds it', () => {
    const oid = commitTree({
      'configs/retry-policy.json': retryConfig({retries: 3}),
      'schemas/broken.json': {properties: {mode: {enum: []}}, type: 'object'},
      'schemas/retry.json': RETRY_SCHEMA,
    })

    const {code, output} = runHook(oid)
    expect(code, output).to.equal(1)
    expect(output).to.include('schemas/broken.json:')
    expect(output).to.include('ERROR: schema broken is invalid:')
  })

  it('rejects a push whose bound schema does not compile', () => {
    const oid = commitTree({
      'configs/retry-policy.json': retryConfig({retries: 3}),
      'schemas/retry.json': {properties: {retries: {enum: []}}, type: 'object'},
    })

    const {code, output} = runHook(oid)
    expect(code, output).to.equal(1)
    expect(output).to.include('schemas/retry.json:')
    expect(output).to.include('ERROR: schema retry is invalid:')
  })

  it('accepts an unrelated change in a tree that has schemas and valid values', () => {
    const base = commitTree({
      'configs/other.json': stringConfig('other', 'a'),
      'configs/retry-policy.json': retryConfig({retries: 3}),
      'schemas/retry.json': RETRY_SCHEMA,
    })
    const next = commitTree({'configs/other.json': stringConfig('other', 'b')}, 'unrelated change')

    const {code, output} = runHook(next, base)
    expect(code, output).to.equal(0)
    expect(output).to.include('OK:')
  })
})
