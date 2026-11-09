import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {findLocalOnlyWorkspace} from '../../src/util/local-workspace-guard.js'

describe('findLocalOnlyWorkspace', () => {
  let root: string
  let home: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-local-guard-')))
    home = path.join(root, 'home')
    fs.mkdirSync(home)
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  const workspace = (name: string, contents: string): string => {
    const dir = path.join(home, name)
    fs.mkdirSync(path.join(dir, 'nested'), {recursive: true})
    fs.writeFileSync(path.join(dir, 'quonfig.json'), contents)
    return dir
  }

  it('finds an unpinned workspace by walking up from cwd', () => {
    const dir = workspace('local', '{"environments": []}\n')
    expect(findLocalOnlyWorkspace({cwd: path.join(dir, 'nested'), envDir: undefined, homeDir: home})).to.equal(dir)
  })

  it('finds an unpinned workspace named by QUONFIG_DIR', () => {
    const dir = workspace('local', '{}')
    expect(findLocalOnlyWorkspace({cwd: home, envDir: dir, homeDir: home})).to.equal(dir)
  })

  it('ignores a workspace pinned to a hosted workspace', () => {
    const dir = workspace('pinned', '{"workspace": "acme/foo"}')
    expect(findLocalOnlyWorkspace({cwd: dir, envDir: undefined, homeDir: home})).to.equal(undefined)
  })

  it('returns undefined when there is no workspace at all', () => {
    expect(findLocalOnlyWorkspace({cwd: home, envDir: undefined, homeDir: home})).to.equal(undefined)
  })

  it('does not block on an unreadable quonfig.json', () => {
    const dir = workspace('broken', '{not json')
    expect(findLocalOnlyWorkspace({cwd: dir, envDir: undefined, homeDir: home})).to.equal(undefined)
  })
})
