import {expect} from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {getSource, listSources, UnknownSourceError} from '../../src/migrate/registry.js'

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('migrate/registry', () => {
  describe('getSource', () => {
    it('returns the launch source for "launch"', () => {
      const source = getSource('launch')
      expect(source.name).to.equal('launch')
    })

    it('returns the launchdarkly source, which identifies itself', () => {
      const source = getSource('launchdarkly')
      expect(source.name).to.equal('launchdarkly')
    })

    it('returns the flagsmith source, which identifies itself', () => {
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

  describe('launchdarkly source', () => {
    const source = getSource('launchdarkly')

    // The stub is gone (qfg-88cx) — launchdarkly is now a real MigrationSource.
    // Behavioral coverage lives in launchdarkly-{api,translate,source}.test.ts;
    // here we just guard against a regression back to NotYetImplementedError.
    it('translate() no longer throws NotYetImplementedError', () => {
      const result = source.translate({raw: {}, source: 'launchdarkly'})
      expect(result).to.be.an('array')
    })

    it('ships a README.md reflecting the frozen, ratified design (qfg-88cx.1)', () => {
      const readmePath = path.join(CLI_ROOT, 'src', 'migrate', 'sources', 'launchdarkly.README.md')
      expect(fs.existsSync(readmePath), `expected ${readmePath} to exist`).to.equal(true)
      const contents = fs.readFileSync(readmePath, 'utf8').toLowerCase()
      // Frozen decisions D1/D2/D3/D8 are documented, not presented as open.
      expect(contents).to.contain('quonfig _is_ the intermediate representation')
      expect(contents).to.contain('full re-snapshot')
      expect(contents).to.contain('skip + report')
      // The semver gap is explicitly marked closed.
      expect(contents).to.contain('semver gap — closed')
      // The genuinely-open decisions still point at the plan.
      expect(contents).to.contain('§9.2')
    })
  })

  describe('flagsmith source', () => {
    const source = getSource('flagsmith')

    // Epic 1 (fetcher) landed — validateAuth / listEnvironments / fetchChanges
    // are no longer stubs. Behavioural coverage lives in
    // flagsmith-{api,source}.test.ts; here we just guard the surface.
    it('implements the MigrationSource interface', () => {
      expect(source.validateAuth).to.be.a('function')
      expect(source.listEnvironments).to.be.a('function')
      expect(source.fetchChanges).to.be.a('function')
      expect(source.translate).to.be.a('function')
    })

    // Epic 3 landed — translate() now dispatches to flagsmith/translate.ts.
    it('translate() emits a QuonfigFile for a minimal segment LegacyChange', () => {
      const out = source.translate({
        raw: {
          data: {id: 1, name: 'seg-x', project: 38_856, rules: [], uuid: 'u'},
          kind: 'segment',
        },
        source: 'flagsmith',
      })
      expect(out).to.have.length(1)
      expect(out[0].path).to.equal('segments/seg-x.json')
    })

    it('documents the Epic-1 fetcher design and Epic-3 converter pointer', () => {
      const sourcePath = path.join(CLI_ROOT, 'src', 'migrate', 'sources', 'flagsmith.ts')
      const contents = fs.readFileSync(sourcePath, 'utf8').toLowerCase()
      // The header comment explains the read/write split and the LegacyChange shape.
      expect(contents).to.contain('legacychange')
      expect(contents).to.contain('epic 3')
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
