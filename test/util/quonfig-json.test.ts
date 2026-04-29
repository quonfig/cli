import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {readWorkspaceSlug, upsertWorkspaceKey, writeWorkspaceSlug} from '../../src/util/quonfig-json.js'

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

    it('preserves single-line array formatting when inserting the pin', async () => {
      // This is the our-config shape — environments rendered on one line.
      // Format-stable insert should leave that line untouched.
      const original = `{
  "environments": ["production", "staging", "development"]
}
`
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), original)

      await writeWorkspaceSlug(tmpDir, 'our-config')

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      expect(raw).to.equal(`{
  "environments": ["production", "staging", "development"],
  "workspace": "our-config"
}
`)
    })

    it('replaces an existing pin in place without reformatting other fields', async () => {
      const original = `{
  "environments": ["production", "staging"],
  "workspace": "old-slug"
}
`
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), original)

      await writeWorkspaceSlug(tmpDir, 'new-slug')

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      expect(raw).to.equal(`{
  "environments": ["production", "staging"],
  "workspace": "new-slug"
}
`)
    })

    it('falls back to canonical JSON when the file is unparseable', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{ this is not json')

      await writeWorkspaceSlug(tmpDir, 'fallback')

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      const written = JSON.parse(raw)
      expect(written).to.deep.equal({workspace: 'fallback'})
      expect(raw.endsWith('\n')).to.equal(true)
    })
  })

  describe('upsertWorkspaceKey', () => {
    it('inserts the pin into a single-line object without reformatting', () => {
      const out = upsertWorkspaceKey('{"environments":["a"]}', 'slug')
      expect(out).to.equal('{"environments":["a"], "workspace": "slug"}')
    })

    it('inserts the pin into an empty multi-line object', () => {
      const out = upsertWorkspaceKey('{\n}\n', 'slug')
      expect(out).to.equal('{\n  "workspace": "slug"\n}\n')
    })

    it('inserts the pin into an empty single-line object', () => {
      const out = upsertWorkspaceKey('{}', 'slug')
      expect(out).to.equal('{"workspace": "slug"}')
    })

    it('replaces an existing pin value in place', () => {
      const out = upsertWorkspaceKey('{\n  "workspace": "old"\n}\n', 'new')
      expect(out).to.equal('{\n  "workspace": "new"\n}\n')
    })

    it('returns undefined for malformed JSON so callers can fall back', () => {
      expect(upsertWorkspaceKey('{ broken', 'x')).to.equal(undefined)
    })

    it('returns undefined for a non-object root', () => {
      expect(upsertWorkspaceKey('[1,2,3]', 'x')).to.equal(undefined)
    })
  })
})
