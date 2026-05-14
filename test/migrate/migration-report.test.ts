import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildMigrationReport,
  type MigrationReportData,
  writeMigrationReport,
} from '../../src/migrate/migration-report.js'

const baseData = (overrides: Partial<MigrationReportData> = {}): MigrationReportData => ({
  cleanMappings: [],
  counts: {
    configsMigrated: 0,
    environmentsMapped: 0,
    flagsMigrated: 0,
    itemsSkipped: 0,
    logLevelsMigrated: 0,
    schemasMigrated: 0,
    segmentsMigrated: 0,
  },
  dryRun: false,
  environmentMap: [],
  followUp: {
    mustFixBeforeCutover: [],
    reviewPostCutover: [],
  },
  identifierMap: {},
  lossyMappings: [],
  source: 'launch',
  unsupportedFeatures: [],
  ...overrides,
})

describe('migrate/migration-report', () => {
  describe('buildMigrationReport', () => {
    it('renders all 7 required sections', () => {
      const md = buildMigrationReport(baseData())
      expect(md).to.match(/^#\s*Migration Report/m)
      expect(md).to.match(/^##\s*Counts/m)
      expect(md).to.match(/^##\s*Clean mapping/m)
      expect(md).to.match(/^##\s*Lossy mapping/m)
      expect(md).to.match(/^##\s*Unsupported feature/m)
      expect(md).to.match(/^##\s*Environment mapping/m)
      expect(md).to.match(/^##\s*Identifier map/m)
      expect(md).to.match(/^##\s*Follow-up checklist/m)
    })

    it('includes the source name in the header', () => {
      const md = buildMigrationReport(baseData({source: 'launch'}))
      expect(md).to.match(/launch/i)
    })

    it('renders a DRY RUN banner at the top when dryRun is true', () => {
      const md = buildMigrationReport(baseData({dryRun: true}))
      const firstNonEmpty = md.split('\n').find((line) => line.trim() !== '')
      expect(firstNonEmpty, 'first non-empty line').to.match(/DRY RUN/)
    })

    it('omits the DRY RUN banner when dryRun is false', () => {
      const md = buildMigrationReport(baseData({dryRun: false}))
      expect(md).to.not.match(/DRY RUN/)
    })

    it('prints the four count metrics in the Counts section', () => {
      const md = buildMigrationReport(
        baseData({
          counts: {
            configsMigrated: 7,
            environmentsMapped: 3,
            flagsMigrated: 12,
            itemsSkipped: 1,
            logLevelsMigrated: 0,
            schemasMigrated: 0,
            segmentsMigrated: 4,
          },
        }),
      )
      expect(md).to.match(/Flags migrated.*12/)
      expect(md).to.match(/Segments migrated.*4/)
      expect(md).to.match(/Environments mapped.*3/)
      expect(md).to.match(/Items skipped.*1/)
    })

    it('lists every clean-mapping entry with legacy→quonfig pair', () => {
      const md = buildMigrationReport(
        baseData({
          cleanMappings: [
            {legacyKey: 'my-flag', quonfigKey: 'my_flag'},
            {legacyKey: 'other-flag', quonfigKey: 'other_flag'},
          ],
        }),
      )
      expect(md).to.include('my-flag')
      expect(md).to.include('my_flag')
      expect(md).to.include('other-flag')
      expect(md).to.include('other_flag')
    })

    it('lists every lossy mapping with the reason text', () => {
      const md = buildMigrationReport(
        baseData({
          lossyMappings: [
            {
              legacyKey: 'weighted-flag',
              quonfigKey: 'weighted_flag',
              reason: 'weighted_values variant type not supported; collapsed to default variant',
            },
          ],
        }),
      )
      expect(md).to.include('weighted-flag')
      expect(md).to.include('weighted_flag')
      expect(md).to.include('weighted_values variant type not supported')
    })

    it('lists a case-insensitive identifier collision in the lossy-mapping section with an explanation', () => {
      const md = buildMigrationReport(
        baseData({
          lossyMappings: [
            {
              legacyKey: 'FooFlag',
              quonfigKey: 'foo_flag__1',
              reason:
                'case-insensitive filename collision with "fooFlag" — renamed with numeric suffix to avoid overwrite on macOS/Windows',
            },
          ],
        }),
      )
      expect(md).to.include('FooFlag')
      expect(md).to.match(/case-insensitive/i)
      expect(md).to.include('foo_flag__1')
    })

    it('lists unsupported features when present', () => {
      const md = buildMigrationReport(
        baseData({
          unsupportedFeatures: [
            {feature: 'prerequisite flags', note: 'not represented in Quonfig schema'},
            {feature: 'AI Configs'},
          ],
        }),
      )
      expect(md).to.include('prerequisite flags')
      expect(md).to.include('AI Configs')
    })

    it('renders the environment mapping as a markdown table', () => {
      const md = buildMigrationReport(
        baseData({
          environmentMap: [
            {quonfigName: 'production', sourceName: 'Production'},
            {quonfigName: 'staging', sourceName: 'Staging'},
          ],
        }),
      )
      expect(md).to.match(/\|\s*Source\s*\|\s*Quonfig\s*\|/)
      expect(md).to.include('Production')
      expect(md).to.include('production')
      expect(md).to.include('Staging')
      expect(md).to.include('staging')
    })

    it('renders the identifier map with every legacy→quonfig pair, sorted by legacy key', () => {
      const md = buildMigrationReport(
        baseData({
          identifierMap: {'z-flag': 'z_flag', 'a-flag': 'a_flag'},
        }),
      )
      const idSection = md.slice(md.indexOf('## Identifier map'))
      const aIdx = idSection.indexOf('a-flag')
      const zIdx = idSection.indexOf('z-flag')
      expect(aIdx).to.be.greaterThan(-1)
      expect(zIdx).to.be.greaterThan(-1)
      expect(aIdx).to.be.lessThan(zIdx)
      expect(idSection).to.include('a_flag')
      expect(idSection).to.include('z_flag')
    })

    it('splits the follow-up checklist into "Must fix before cutover" and "Review post-cutover"', () => {
      const md = buildMigrationReport(
        baseData({
          followUp: {
            mustFixBeforeCutover: ['Rename colliding flag "FooFlag"'],
            reviewPostCutover: ['Confirm staging variant values'],
          },
        }),
      )
      expect(md).to.match(/###?\s*Must fix before cutover/)
      expect(md).to.match(/###?\s*Review post-cutover/)
      const mustIdx = md.indexOf('Must fix before cutover')
      const reviewIdx = md.indexOf('Review post-cutover')
      expect(md.slice(mustIdx, reviewIdx)).to.include('Rename colliding flag "FooFlag"')
      expect(md.slice(reviewIdx)).to.include('Confirm staging variant values')
    })

    it('renders "(none)" placeholders for empty sections so humans know the section was considered', () => {
      const md = buildMigrationReport(baseData())
      const clean = md.slice(md.indexOf('## Clean mapping'), md.indexOf('## Lossy mapping'))
      expect(clean.toLowerCase()).to.include('(none)')
    })
  })

  describe('writeMigrationReport', () => {
    let tmpdir: string

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-report-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpdir, {force: true, recursive: true})
    })

    it('writes MIGRATION_REPORT.md at the output dir root', () => {
      writeMigrationReport(tmpdir, baseData())
      const reportPath = path.join(tmpdir, 'MIGRATION_REPORT.md')
      expect(fs.existsSync(reportPath)).to.equal(true)
      const contents = fs.readFileSync(reportPath, 'utf8')
      expect(contents).to.match(/^#\s*Migration Report/m)
    })

    it('overwrites an existing MIGRATION_REPORT.md on re-run', () => {
      fs.writeFileSync(path.join(tmpdir, 'MIGRATION_REPORT.md'), 'OLD CONTENT\n')

      writeMigrationReport(
        tmpdir,
        baseData({
          counts: {
            configsMigrated: 0,
            environmentsMapped: 1,
            flagsMigrated: 2,
            itemsSkipped: 0,
            logLevelsMigrated: 0,
            schemasMigrated: 0,
            segmentsMigrated: 0,
          },
        }),
      )

      const contents = fs.readFileSync(path.join(tmpdir, 'MIGRATION_REPORT.md'), 'utf8')
      expect(contents).to.not.include('OLD CONTENT')
      expect(contents).to.match(/Flags migrated.*2/)
    })

    it('reflects only the current run when called with delta data after a prior run', () => {
      // First run: 10 flags migrated
      writeMigrationReport(
        tmpdir,
        baseData({
          counts: {
            configsMigrated: 0,
            environmentsMapped: 2,
            flagsMigrated: 10,
            itemsSkipped: 0,
            logLevelsMigrated: 0,
            schemasMigrated: 0,
            segmentsMigrated: 3,
          },
          identifierMap: {'flag-1': 'flag_1', 'flag-2': 'flag_2'},
        }),
      )

      // Re-run with delta only: 1 flag changed
      writeMigrationReport(
        tmpdir,
        baseData({
          counts: {
            configsMigrated: 0,
            environmentsMapped: 0,
            flagsMigrated: 1,
            itemsSkipped: 0,
            logLevelsMigrated: 0,
            schemasMigrated: 0,
            segmentsMigrated: 0,
          },
          identifierMap: {'flag-3': 'flag_3'},
        }),
      )

      const contents = fs.readFileSync(path.join(tmpdir, 'MIGRATION_REPORT.md'), 'utf8')
      expect(contents).to.match(/Flags migrated.*1/)
      expect(contents).to.not.include('flag-1')
      expect(contents).to.not.include('flag-2')
      expect(contents).to.include('flag-3')
    })

    it('still writes a report when dryRun=true', () => {
      writeMigrationReport(tmpdir, baseData({dryRun: true}))
      const contents = fs.readFileSync(path.join(tmpdir, 'MIGRATION_REPORT.md'), 'utf8')
      expect(contents).to.match(/DRY RUN/)
    })

    it('creates the output directory if it does not exist', () => {
      const nested = path.join(tmpdir, 'nested', 'out')
      writeMigrationReport(nested, baseData())
      expect(fs.existsSync(path.join(nested, 'MIGRATION_REPORT.md'))).to.equal(true)
    })
  })
})
