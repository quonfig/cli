import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assertSourceMatches,
  CrossSourceError,
  readImportState,
  removeQfFromGitignore,
  writeImportState,
} from '../../src/migrate/import-state.js'

describe('migrate/import-state', () => {
  let tmpdir: string

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-state-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpdir, {force: true, recursive: true})
  })

  describe('writeImportState', () => {
    it('creates .qf/import-state.json containing the source field', () => {
      writeImportState(tmpdir, {
        lastProcessedAt: 1_713_400_000_000,
        source: 'launch',
        sourceWorkspaceId: 'acme-prod',
      })

      const filePath = path.join(tmpdir, '.qf', 'import-state.json')
      expect(fs.existsSync(filePath)).to.equal(true)
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      expect(parsed.source).to.equal('launch')
      expect(parsed.lastProcessedAt).to.equal(1_713_400_000_000)
      expect(parsed.sourceWorkspaceId).to.equal('acme-prod')
    })

    it('creates the .qf directory if it does not exist', () => {
      writeImportState(tmpdir, {source: 'launch'})
      expect(fs.existsSync(path.join(tmpdir, '.qf'))).to.equal(true)
    })

    it('writes deterministic JSON with a trailing newline', () => {
      writeImportState(tmpdir, {
        lastProcessedAt: 1_713_400_000_000,
        source: 'launch',
        sourceWorkspaceId: 'acme-prod',
      })
      const raw = fs.readFileSync(path.join(tmpdir, '.qf', 'import-state.json'), 'utf8')
      expect(raw.endsWith('\n')).to.equal(true)
      // Round-trip must preserve required + optional fields
      const parsed = JSON.parse(raw)
      expect(parsed).to.deep.equal({
        lastProcessedAt: 1_713_400_000_000,
        source: 'launch',
        sourceWorkspaceId: 'acme-prod',
      })
    })
  })

  describe('readImportState', () => {
    it('returns null when the file does not exist', () => {
      expect(readImportState(tmpdir)).to.equal(null)
    })

    it('round-trips a written state', () => {
      const state = {
        lastProcessedAt: 1_713_400_000_000,
        source: 'launch',
        sourceWorkspaceId: 'acme-prod',
      }
      writeImportState(tmpdir, state)
      expect(readImportState(tmpdir)).to.deep.equal(state)
    })
  })

  describe('assertSourceMatches', () => {
    it('does not throw when no state file exists (first run)', () => {
      expect(() => assertSourceMatches(tmpdir, 'launch')).to.not.throw()
    })

    it('does not throw when stored source matches requested source', () => {
      writeImportState(tmpdir, {source: 'launch'})
      expect(() => assertSourceMatches(tmpdir, 'launch')).to.not.throw()
    })

    it('throws CrossSourceError when stored source does not match', () => {
      writeImportState(tmpdir, {source: 'launch'})
      expect(() => assertSourceMatches(tmpdir, 'flagsmith')).to.throw(CrossSourceError)
    })

    it('error message names both sources and mentions --reset', () => {
      writeImportState(tmpdir, {source: 'launch'})

      let caught: unknown
      try {
        assertSourceMatches(tmpdir, 'flagsmith')
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(CrossSourceError)
      const message = (caught as Error).message
      expect(message).to.include('launch')
      expect(message).to.include('flagsmith')
      expect(message).to.include('--from launch')
      expect(message).to.include('--reset')
    })
  })

  describe('removeQfFromGitignore', () => {
    it('does nothing when no .gitignore exists', () => {
      expect(() => removeQfFromGitignore(tmpdir)).to.not.throw()
      expect(fs.existsSync(path.join(tmpdir, '.gitignore'))).to.equal(false)
    })

    it('removes a `.qf/` line from an existing .gitignore', () => {
      const gitignorePath = path.join(tmpdir, '.gitignore')
      fs.writeFileSync(gitignorePath, 'node_modules\n.qf/\n.DS_Store\n')

      removeQfFromGitignore(tmpdir)

      const contents = fs.readFileSync(gitignorePath, 'utf8')
      expect(contents).to.not.match(/^\.qf\/?$/m)
      // Other entries must be preserved
      expect(contents).to.include('node_modules')
      expect(contents).to.include('.DS_Store')
    })

    it('removes a bare `.qf` line (no trailing slash) too', () => {
      const gitignorePath = path.join(tmpdir, '.gitignore')
      fs.writeFileSync(gitignorePath, '.qf\nother\n')

      removeQfFromGitignore(tmpdir)

      const contents = fs.readFileSync(gitignorePath, 'utf8')
      expect(contents).to.not.match(/^\.qf\/?$/m)
      expect(contents).to.include('other')
    })

    it('leaves .gitignore untouched if .qf/ is not listed', () => {
      const gitignorePath = path.join(tmpdir, '.gitignore')
      const original = 'node_modules\n.DS_Store\n'
      fs.writeFileSync(gitignorePath, original)

      removeQfFromGitignore(tmpdir)

      expect(fs.readFileSync(gitignorePath, 'utf8')).to.equal(original)
    })
  })
})
