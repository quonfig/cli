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
    it('returns {orgSlug, workspaceSlug} when the workspace field is in org/ws form', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        JSON.stringify({environments: ['production'], workspace: 'acme/foo'}, null, 2) + '\n',
      )

      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.deep.equal({orgSlug: 'acme', workspaceSlug: 'foo'})
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

    it('throws with migration message when workspace field is a bare slug', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify({workspace: 'foo'}))

      let err: Error | undefined
      try {
        await readWorkspaceSlug(tmpDir)
      } catch (error) {
        err = error as Error
      }

      expect(err).to.exist
      expect(err!.message).to.include('quonfig.json workspace value must be in org/workspace form')
      expect(err!.message).to.include('acme/foo')
      expect(err!.message).to.include('qfg login')
    })

    it('throws when workspace value has empty org or workspace component', async () => {
      const cases = ['/foo', 'acme/', '/', 'acme/foo/extra']
      for (const value of cases) {
        fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify({workspace: value}))
        let threw = false
        try {
          await readWorkspaceSlug(tmpDir)
        } catch {
          threw = true
        }

        expect(threw, `expected throw for value ${JSON.stringify(value)}`).to.equal(true)
      }
    })
  })

  describe('writeWorkspaceSlug', () => {
    it('writes the org/workspace form while preserving other fields', async () => {
      const original = {
        environments: ['production', 'staging'],
        somethingElse: {nested: true},
      }
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify(original, null, 2) + '\n')

      await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: 'foo'})

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8'))
      expect(written.workspace).to.equal('acme/foo')
      expect(written.environments).to.deep.equal(['production', 'staging'])
      expect(written.somethingElse).to.deep.equal({nested: true})
    })

    it('overwrites an existing workspace field', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'quonfig.json'),
        JSON.stringify({environments: [], workspace: 'old-org/old-ws'}, null, 2) + '\n',
      )

      await writeWorkspaceSlug(tmpDir, {orgSlug: 'new-org', workspaceSlug: 'new-ws'})

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8'))
      expect(written.workspace).to.equal('new-org/new-ws')
    })

    it('creates a minimal quonfig.json when the file is missing', async () => {
      await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: 'fresh'})

      const filePath = path.join(tmpDir, 'quonfig.json')
      expect(fs.existsSync(filePath)).to.equal(true)

      const raw = fs.readFileSync(filePath, 'utf8')
      expect(raw.endsWith('\n')).to.equal(true) // trailing newline matches house style

      const written = JSON.parse(raw)
      expect(written).to.deep.equal({workspace: 'acme/fresh'})
    })

    it('writes 2-space indent and trailing newline', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), JSON.stringify({environments: []}, null, 2) + '\n')

      await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: 'foo'})

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      // Two-space indent on first nested key
      expect(raw).to.include('\n  "')
      expect(raw.endsWith('\n')).to.equal(true)
    })

    it('round-trips: writeWorkspaceSlug then readWorkspaceSlug returns the struct', async () => {
      await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: 'round-trip'})
      const slug = await readWorkspaceSlug(tmpDir)
      expect(slug).to.deep.equal({orgSlug: 'acme', workspaceSlug: 'round-trip'})
    })

    it('preserves single-line array formatting when inserting the pin', async () => {
      // This is the our-config shape — environments rendered on one line.
      // Format-stable insert should leave that line untouched.
      const original = `{
  "environments": ["production", "staging", "development"]
}
`
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), original)

      await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: 'our-config'})

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      expect(raw).to.equal(`{
  "environments": ["production", "staging", "development"],
  "workspace": "acme/our-config"
}
`)
    })

    it('replaces an existing pin in place without reformatting other fields', async () => {
      const original = `{
  "environments": ["production", "staging"],
  "workspace": "old-org/old-ws"
}
`
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), original)

      await writeWorkspaceSlug(tmpDir, {orgSlug: 'new-org', workspaceSlug: 'new-ws'})

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      expect(raw).to.equal(`{
  "environments": ["production", "staging"],
  "workspace": "new-org/new-ws"
}
`)
    })

    it('falls back to canonical JSON when the file is unparseable', async () => {
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{ this is not json')

      await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: 'fallback'})

      const raw = fs.readFileSync(path.join(tmpDir, 'quonfig.json'), 'utf8')
      const written = JSON.parse(raw)
      expect(written).to.deep.equal({workspace: 'acme/fallback'})
      expect(raw.endsWith('\n')).to.equal(true)
    })

    it('throws when the orgSlug is empty', async () => {
      let threw = false
      try {
        await writeWorkspaceSlug(tmpDir, {orgSlug: '', workspaceSlug: 'foo'})
      } catch {
        threw = true
      }

      expect(threw).to.equal(true)
    })

    it('throws when the workspaceSlug is empty', async () => {
      let threw = false
      try {
        await writeWorkspaceSlug(tmpDir, {orgSlug: 'acme', workspaceSlug: ''})
      } catch {
        threw = true
      }

      expect(threw).to.equal(true)
    })

    it('throws when an org or workspace slug contains a slash', async () => {
      let threw = false
      try {
        await writeWorkspaceSlug(tmpDir, {orgSlug: 'a/b', workspaceSlug: 'foo'})
      } catch {
        threw = true
      }

      expect(threw).to.equal(true)
    })
  })

  describe('upsertWorkspaceKey', () => {
    it('inserts the pin into a single-line object without reformatting', () => {
      const out = upsertWorkspaceKey('{"environments":["a"]}', 'acme/slug')
      expect(out).to.equal('{"environments":["a"], "workspace": "acme/slug"}')
    })

    it('inserts the pin into an empty multi-line object', () => {
      const out = upsertWorkspaceKey('{\n}\n', 'acme/slug')
      expect(out).to.equal('{\n  "workspace": "acme/slug"\n}\n')
    })

    it('inserts the pin into an empty single-line object', () => {
      const out = upsertWorkspaceKey('{}', 'acme/slug')
      expect(out).to.equal('{"workspace": "acme/slug"}')
    })

    it('replaces an existing pin value in place', () => {
      const out = upsertWorkspaceKey('{\n  "workspace": "old/one"\n}\n', 'new/two')
      expect(out).to.equal('{\n  "workspace": "new/two"\n}\n')
    })

    it('returns undefined for malformed JSON so callers can fall back', () => {
      expect(upsertWorkspaceKey('{ broken', 'acme/x')).to.equal(undefined)
    })

    it('returns undefined for a non-object root', () => {
      expect(upsertWorkspaceKey('[1,2,3]', 'acme/x')).to.equal(undefined)
    })
  })
})
