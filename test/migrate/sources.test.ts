import {expect} from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {getSource, listSources, UnknownSourceError} from '../../src/migrate/registry.js'
import {NotYetImplementedError} from '../../src/migrate/source.js'

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('migrate/registry', () => {
  describe('getSource', () => {
    it('returns the launch source for "launch"', () => {
      const source = getSource('launch')
      expect(source.name).to.equal('launch')
    })

    it('returns a launchdarkly stub that identifies itself', () => {
      const source = getSource('launchdarkly')
      expect(source.name).to.equal('launchdarkly')
    })

    it('returns a flagsmith stub that identifies itself', () => {
      const source = getSource('flagsmith')
      expect(source.name).to.equal('flagsmith')
    })

    it('throws UnknownSourceError for unrecognized sources', () => {
      expect(() => getSource('split')).to.throw(UnknownSourceError, /split/)
    })
  })

  describe('listSources', () => {
    it('includes all supported --from values', () => {
      const names = listSources()
      expect(names).to.include.members(['launch', 'launchdarkly', 'flagsmith'])
    })
  })

  describe('launchdarkly stub', () => {
    const source = getSource('launchdarkly')

    it('throws NotYetImplementedError on validateAuth with a bead-file link', async () => {
      try {
        await source.validateAuth('sdk-xxx')
        expect.fail('expected validateAuth to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(NotYetImplementedError)
        const message = (error as Error).message
        expect(message.toLowerCase()).to.contain('not yet implemented')
        expect(message.toLowerCase()).to.contain('launchdarkly')
        expect(message).to.match(/github\.com\/quonfig\/cli\/issues/i)
      }
    })

    it('throws NotYetImplementedError on listEnvironments', async () => {
      try {
        await source.listEnvironments()
        expect.fail('expected listEnvironments to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(NotYetImplementedError)
      }
    })

    it('throws NotYetImplementedError on fetchChanges', async () => {
      try {
        const iter = source.fetchChanges(null)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iter) {
          // consume to trigger generator body
        }
        expect.fail('expected fetchChanges to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(NotYetImplementedError)
      }
    })

    it('throws NotYetImplementedError on translate', () => {
      expect(() => source.translate({source: 'launchdarkly', raw: {}})).to.throw(NotYetImplementedError)
    })

    it('ships a README.md documenting the schema gaps that block implementation', () => {
      const readmePath = path.join(CLI_ROOT, 'src', 'migrate', 'sources', 'launchdarkly.README.md')
      expect(fs.existsSync(readmePath), `expected ${readmePath} to exist`).to.equal(true)
      const contents = fs.readFileSync(readmePath, 'utf8').toLowerCase()
      expect(contents).to.contain('prerequisite')
      expect(contents).to.contain('individual')
      expect(contents).to.contain('privateattributes')
      expect(contents).to.contain('semver')
      expect(contents).to.contain('audit')
    })
  })

  describe('flagsmith stub', () => {
    const source = getSource('flagsmith')

    it('throws NotYetImplementedError on validateAuth with a bead-file link', async () => {
      try {
        await source.validateAuth('sdk-xxx')
        expect.fail('expected validateAuth to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(NotYetImplementedError)
        const message = (error as Error).message
        expect(message.toLowerCase()).to.contain('flagsmith')
        expect(message).to.match(/github\.com\/quonfig\/cli\/issues/i)
      }
    })

    it('throws NotYetImplementedError on listEnvironments', async () => {
      try {
        await source.listEnvironments()
        expect.fail('expected listEnvironments to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(NotYetImplementedError)
      }
    })

    it('throws NotYetImplementedError on fetchChanges', async () => {
      try {
        const iter = source.fetchChanges(null)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iter) {
          // consume to trigger generator body
        }

        expect.fail('expected fetchChanges to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(NotYetImplementedError)
      }
    })

    it('throws NotYetImplementedError on translate', () => {
      expect(() => source.translate({source: 'flagsmith', raw: {}})).to.throw(NotYetImplementedError)
    })

    it('documents what must be investigated before the stub becomes real', () => {
      const stubPath = path.join(CLI_ROOT, 'src', 'migrate', 'sources', 'flagsmith.ts')
      const contents = fs.readFileSync(stubPath, 'utf8').toLowerCase()
      expect(contents).to.contain('flagsmith api')
      expect(contents).to.match(/delta|cursor/)
    })
  })

  describe('launch source', () => {
    const source = getSource('launch')

    it('implements the MigrationSource interface', () => {
      expect(source.validateAuth).to.be.a('function')
      expect(source.listEnvironments).to.be.a('function')
      expect(source.fetchChanges).to.be.a('function')
      expect(source.translate).to.be.a('function')
    })
  })
})
