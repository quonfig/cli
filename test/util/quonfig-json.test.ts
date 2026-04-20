import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {readWorkspaceSlug, writeWorkspaceSlug} from '../../src/util/quonfig-json.js'

describe('quonfig-json utils', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-json-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {force: true, recursive: true})
  })

  describe('readWorkspaceSlug', () => {
    it('returns the workspace slug when the field is present', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        JSON.stringify({environments: ['production'], workspace: 'acme'}, null, 2) + '\n',
      )

      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.equal('acme')
    })

    it('returns undefined when the workspace field is absent', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        JSON.stringify({environments: ['production']}, null, 2) + '\n',
      )

      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.equal(undefined)
    })

    it('returns undefined when quonfig.json does not exist', async () => {
      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.equal(undefined)
    })

    it('throws when quonfig.json is malformed JSON', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{ this is not json')

      let threw = false
      try {
        await readWorkspaceSlug(tmpDir)
      } catch {
        threw = true
      }

      expect(threw).to.equal(true)
    })

    it('returns undefined when workspace field exists but is not a string', async () => {
      // Defensive: malformed-but-parseable file shouldn't crash a downstream guard
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify({workspace: 123}))

      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.equal(undefined)
    })
  })

  describe('writeWorkspaceSlug', () => {
    it('adds the workspace field while preserving other fields', async () => {
      const original = {
        environments: ['production', 'staging'],
        somethingElse: {nested: true},
      }
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify(original, null, 2) + '\n')

      await writeWorkspaceSlug(tmpDir, 'acme-prod')

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8'))
      expect(written.workspace).to.equal('acme-prod')
      expect(written.environments).to.deep.equal(['production', 'staging'])
      expect(written.somethingElse).to.deep.equal({nested: true})
    })

    it('overwrites an existing workspace field', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        JSON.stringify({environments: [], workspace: 'old-slug'}, null, 2) + '\n',
      )

      await writeWorkspaceSlug(tmpDir, 'new-slug')

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8'))
      expect(written.workspace).to.equal('new-slug')
    })

    it('creates a minimal quonfig.json when the file is missing', async () => {
      await writeWorkspaceSlug(tmpDir, 'fresh-slug')

      const filePath = path.join(tmpDir, 'quonfig.json')
      expect(fs.existsSync(filePath)).to.equal(true)

      const raw = fs.readFileSync(filePath, 'utf8')
      expect(raw.endsWith('\n')).to.equal(true) // trailing newline matches house style

      const written = JSON.parse(raw)
      expect(written).to.deep.equal({workspace: 'fresh-slug'})
    })

    it('writes 2-space indent and trailing newline', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify({environments: []}, null, 2) + '\n')

      await writeWorkspaceSlug(tmpDir, 'acme')

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      // Two-space indent on first nested key
      expect(raw).to.include('\n  "')
      expect(raw.endsWith('\n')).to.equal(true)
    })

    it('round-trips: writeWorkspaceSlug then readWorkspaceSlug returns the slug', async () => {
      await writeWorkspaceSlug(tmpDir, 'round-trip')
      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.equal('round-trip')
    })
  })
})
