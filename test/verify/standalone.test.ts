import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {readFilesFromCommit} from '../../src/verify/standalone.js'
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
    const oid = commitAll(dir)

    // A bogus oid makes every git show fail — must throw, not return an empty map
    expect(() => readFilesFromCommit('0'.repeat(40), dir)).to.throw()
  })
})
