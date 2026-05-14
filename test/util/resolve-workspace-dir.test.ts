import {expect} from '@oclif/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {describe, it} from 'mocha'

import {NO_WORKSPACE_DIR_ERROR, resolveWorkspaceDir} from '../../src/util/resolve-workspace-dir.js'

/**
 * Resolution order for `qfg push` / `qfg pull`:
 *
 *   1. `--dir <path>` flag (explicit, wins everything)
 *   2. `QUONFIG_DIR` env var
 *   3. Walk up from cwd looking for `quonfig.json` with a `workspace` pin.
 *      Stop at the first hit, the user's home dir, or the filesystem root.
 *   4. Error: `No Quonfig workspace dir found. Run from inside a workspace,
 *      or pass --dir, or set QUONFIG_DIR.`
 *
 * The function is pure: cwd is passed in, not read from `process.cwd()`. The
 * caller (oclif command) is responsible for wiring `process.cwd()` and the
 * env var; tests drive the function with explicit values.
 */
describe('resolveWorkspaceDir', () => {
  let tmpDir: string

  beforeEach(() => {
    // realpathSync because mkdtempSync returns a path under /var/folders on
    // macOS that's actually a symlink to /private/var/folders. Walking with
    // path.dirname would never escape the symlink, so the "stop at home
    // dir" rule needs the canonical form.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-ws-dir-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {force: true, recursive: true})
  })

  describe('precedence', () => {
    it('returns the resolved --dir flag when provided (highest precedence)', () => {
      const result = resolveWorkspaceDir({
        flagDir: tmpDir,
        envDir: '/some/env/dir',
        cwd: '/some/cwd',
      })

      expect(result).to.deep.equal({kind: 'ok', dir: tmpDir, source: 'flag'})
    })

    it('resolves relative --dir paths against cwd', () => {
      // Use a real relative path to a real dir to keep the test deterministic.
      const parent = path.dirname(tmpDir)
      const base = path.basename(tmpDir)
      const result = resolveWorkspaceDir({
        flagDir: `./${base}`,
        envDir: undefined,
        cwd: parent,
      })

      expect(result.kind).to.equal('ok')
      if (result.kind !== 'ok') return
      expect(result.dir).to.equal(tmpDir)
      expect(result.source).to.equal('flag')
    })

    it('falls through to QUONFIG_DIR env var when --dir is absent', () => {
      const result = resolveWorkspaceDir({
        flagDir: undefined,
        envDir: tmpDir,
        cwd: '/unrelated',
      })

      expect(result).to.deep.equal({kind: 'ok', dir: tmpDir, source: 'env'})
    })

    it('treats empty-string --dir as absent (avoids shell EXPORT_VAR= trap)', () => {
      const result = resolveWorkspaceDir({
        flagDir: '',
        envDir: tmpDir,
        cwd: '/unrelated',
      })

      expect(result).to.deep.equal({kind: 'ok', dir: tmpDir, source: 'env'})
    })

    it('treats empty-string QUONFIG_DIR as absent', () => {
      // Set up a workspace-like dir so the cwd walk can succeed.
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}')
      const result = resolveWorkspaceDir({
        flagDir: undefined,
        envDir: '',
        cwd: tmpDir,
        homeDir: '/some/other/home',
      })

      expect(result.kind).to.equal('ok')
      if (result.kind !== 'ok') return
      expect(result.dir).to.equal(tmpDir)
      expect(result.source).to.equal('cwd-walk')
    })
  })

  describe('cwd walk', () => {
    it('walks up from cwd and finds the first ancestor with a quonfig.json', () => {
      // Layout:
      //   tmpDir/
      //     quonfig.json
      //     feature-flags/
      //       nested/
      const wsDir = tmpDir
      const childDir = path.join(wsDir, 'feature-flags', 'nested')
      fs.mkdirSync(childDir, {recursive: true})
      fs.writeFileSync(path.join(wsDir, 'quonfig.json'), '{}')

      const result = resolveWorkspaceDir({
        flagDir: undefined,
        envDir: undefined,
        cwd: childDir,
        homeDir: path.dirname(tmpDir),
      })

      expect(result.kind).to.equal('ok')
      if (result.kind !== 'ok') return
      expect(result.dir).to.equal(wsDir)
      expect(result.source).to.equal('cwd-walk')
    })

    it('finds quonfig.json directly in cwd (zero-walk case)', () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{}')
      const result = resolveWorkspaceDir({
        flagDir: undefined,
        envDir: undefined,
        cwd: tmpDir,
        homeDir: path.dirname(tmpDir),
      })

      expect(result.kind).to.equal('ok')
      if (result.kind !== 'ok') return
      expect(result.dir).to.equal(tmpDir)
    })

    it('stops walking at the user home dir (does not check home or above)', () => {
      // cwd is inside home, but no quonfig.json exists anywhere → error,
      // never walks above home.
      const homeDir = tmpDir
      const childDir = path.join(homeDir, 'projects', 'somewhere')
      fs.mkdirSync(childDir, {recursive: true})
      // Plant a quonfig.json ABOVE home — we should NOT find it.
      const parent = path.dirname(homeDir)
      fs.writeFileSync(path.join(parent, 'quonfig.json'), '{}')

      const result = resolveWorkspaceDir({
        flagDir: undefined,
        envDir: undefined,
        cwd: childDir,
        homeDir,
      })

      try {
        expect(result.kind).to.equal('error')
        if (result.kind !== 'error') return
        expect(result.message).to.equal(NO_WORKSPACE_DIR_ERROR)
      } finally {
        fs.unlinkSync(path.join(parent, 'quonfig.json'))
      }
    })

    it('errors with the precise message when cwd walk finds nothing', () => {
      const childDir = path.join(tmpDir, 'a', 'b', 'c')
      fs.mkdirSync(childDir, {recursive: true})

      const result = resolveWorkspaceDir({
        flagDir: undefined,
        envDir: undefined,
        cwd: childDir,
        homeDir: path.dirname(tmpDir),
      })

      expect(result.kind).to.equal('error')
      if (result.kind !== 'error') return
      expect(result.message).to.equal(NO_WORKSPACE_DIR_ERROR)
    })
  })
})
