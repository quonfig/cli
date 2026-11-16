/**
 * `qfg cr --help` and the root TOPICS list must describe the `cr` topic itself,
 * not borrow the first subcommand's (`cr close`) description (qfg-5bjew.27).
 * Runs the real bin against dist/: `yarn build` first.
 */

import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runHelp = (...args: string[]) =>
  execFileSync(process.execPath, [resolve(root, 'bin/run.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    // NODE_ENV=test would make oclif load src/*.ts; help must come from dist/.
    env: {...process.env, NODE_ENV: 'production', NODE_OPTIONS: '', NO_COLOR: '1'},
  })

describe('qfg cr topic help (qfg-5bjew.27)', function () {
  this.timeout(30_000)

  it('qfg cr --help leads with the topic description, not cr close', () => {
    const out = runHelp('cr', '--help')
    const [firstLine] = out.trimStart().split('\n')
    expect(firstLine).to.match(/change requests/i)
    expect(firstLine).to.not.match(/Close a change request/)
    expect(out).to.match(/cr close\s+Close a change request without merging it/)
  })

  it('qfg --help lists the cr topic with its own description', () => {
    const out = runHelp('--help')
    const crLine = out.split('\n').find((l) => /^\s+cr\s+/.test(l)) ?? ''
    expect(crLine).to.match(/change requests/i)
    expect(crLine).to.not.match(/Close a change request/)
  })
})
