import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildMigrationReport,
  deriveFollowUpFromConversionNotes,
  type MigrationReportData,
  writeMigrationReport,
} from '../../src/migrate/migration-report.js'
import type {ConversionNote} from '../../src/migrate/quonfig-target/report.js'

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

    describe('Identifier map maintainer rows (qfg-l8uz)', () => {
      it('renders a Maintainer IDs sub-table when maintainerMap is supplied', () => {
        const md = buildMigrationReport(
          baseData({
            maintainerMap: {
              '6a01c58d51b2060a7e9178e1': 'ada@acme.test',
              '7b02d691f1c12abc1234efef': 'bob@acme.test',
            },
          }),
        )
        const start = md.indexOf('## Identifier map')
        const next = md.indexOf('\n## ', start + 1)
        const section = md.slice(start, next === -1 ? undefined : next)
        expect(section).to.include('### Maintainer IDs')
        expect(section).to.include('| maintainerId | email |')
        expect(section).to.include('6a01c58d51b2060a7e9178e1')
        expect(section).to.include('ada@acme.test')
        expect(section).to.include('bob@acme.test')
      })

      it('decorates dropped-maintainer rollup entries with `(email)` when the ID resolves', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [
              {
                category: 'dropped-maintainer',
                key: 'flag-a',
                detail: 'maintainer 6a01c58d51b2060a7e9178e1 dropped — Quonfig authorship lives in git history',
              },
              {
                category: 'dropped-maintainer',
                key: 'flag-b',
                detail: 'maintainer 7b02d691f1c12abc1234efef dropped — Quonfig authorship lives in git history',
              },
            ],
            maintainerMap: {
              '6a01c58d51b2060a7e9178e1': 'ada@acme.test',
            },
          }),
        )
        // Resolved ID is decorated; unresolved one is left untouched (no spurious "()" or empty parens).
        expect(md).to.include('6a01c58d51b2060a7e9178e1 (ada@acme.test)')
        expect(md).to.include('7b02d691f1c12abc1234efef dropped')
        expect(md).to.not.include('7b02d691f1c12abc1234efef (')
      })

      it('falls back to legacy "(none)" placeholder when neither identifierMap nor maintainerMap has entries', () => {
        const md = buildMigrationReport(baseData())
        const start = md.indexOf('## Identifier map')
        const next = md.indexOf('\n## ', start + 1)
        const section = md.slice(start, next === -1 ? undefined : next)
        expect(section.toLowerCase()).to.include('(none)')
      })

      it('omits the Maintainer IDs sub-table when maintainerMap is empty', () => {
        const md = buildMigrationReport(baseData({maintainerMap: {}}))
        expect(md).to.not.include('### Maintainer IDs')
      })
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

    describe('conversion notes (LaunchDarkly converter — plan §5.4)', () => {
      it('renders a "Users will be re-bucketed" section listing every flag with a percentage rollout', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [
              {
                category: 'rebucketed-rollout',
                key: 'checkout-rollout',
                detail: 'percentage rollout hashed on "user.key" — users will be re-bucketed',
              },
              {
                category: 'rebucketed-rollout',
                key: 'beta-banner',
                detail: 'percentage rollout hashed on "user.id" — users will be re-bucketed',
              },
            ],
          }),
        )
        expect(md).to.match(/^##\s*Users will be re-bucketed/m)
        const section = md.slice(md.indexOf('## Users will be re-bucketed'))
        expect(section).to.include('checkout-rollout')
        expect(section).to.include('beta-banner')
        expect(section).to.include('user.key')
      })

      it('omits the re-bucketed section entirely when no rollout was re-bucketed', () => {
        const md = buildMigrationReport(baseData({source: 'launchdarkly', conversionNotes: []}))
        expect(md).to.not.match(/Users will be re-bucketed/)
      })

      it('renders non-rollout conversion notes grouped by category under a Conversion notes section', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [
              {
                category: 'dropped-prerequisite',
                key: 'gated-flag',
                detail: '2 prerequisite(s) dropped — Quonfig has no cross-flag dependency operator',
              },
              {
                category: 'individual-target-as-rule',
                key: 'vip-flag',
                detail: '3 user target(s) converted to a leading PROP_IS_ONE_OF rule on user.key',
              },
            ],
          }),
        )
        expect(md).to.match(/^##\s*Conversion notes/m)
        const section = md.slice(md.indexOf('## Conversion notes'))
        expect(section).to.include('gated-flag')
        expect(section).to.include('vip-flag')
        expect(section).to.match(/prerequisite/i)
      })

      it('keeps skipped-config notes out of the Conversion notes section (they have their own section)', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [{category: 'skipped-config', key: 'broken-flag', detail: 'conversion failed: bad data'}],
          }),
        )
        expect(md).to.not.match(/^##\s*Conversion notes/m)
      })

      const sliceSubsection = (md: string, heading: string): string => {
        const start = md.indexOf(heading)
        if (start === -1) return ''
        const nextHeader = md.indexOf('\n## ', start)
        const nextSubheader = md.indexOf('\n### ', start + 1)
        const candidates = [nextHeader, nextSubheader].filter((i) => i > -1)
        const sectionEnd = candidates.length === 0 ? md.length : Math.min(...candidates)
        return md.slice(start, sectionEnd)
      }

      const countTopLevelBullets = (section: string): number => {
        let insideDetails = false
        let count = 0
        for (const line of section.split('\n')) {
          if (line.includes('<details')) insideDetails = true
          if (!insideDetails && line.startsWith('- ')) count++
          if (line.includes('</details>')) insideDetails = false
        }

        return count
      }

      it('collapses dropped-maintainer entries into a 1-line rollup + <details> block (qfg-ve5w)', () => {
        const maintainerNotes: ConversionNote[] = []
        for (let i = 0; i < 80; i++) {
          maintainerNotes.push({
            category: 'dropped-maintainer',
            detail: `maintainerId user-${i} dropped`,
            key: `flag-${i.toString().padStart(3, '0')}`,
          })
        }

        const md = buildMigrationReport(baseData({conversionNotes: maintainerNotes, source: 'launchdarkly'}))
        const section = sliceSubsection(md, '### Dropped maintainer metadata')
        expect(section, 'subsection present').to.not.equal('')

        // The per-flag list is inside <details>, so it is NOT rendered as 80
        // top-level bullets at the section level.
        expect(countTopLevelBullets(section), 'top-level bullets in maintainer subsection').to.equal(0)

        expect(section).to.include('<details>')
        expect(section).to.include('</details>')
        expect(section).to.match(/80 flag/i)
        // Per-flag entries are still present (just collapsed).
        expect(section).to.include('flag-000')
        expect(section).to.include('flag-079')
      })

      it('collapses dropped-mobile-key-still-visible entries into a 1-line rollup + <details> block (qfg-iv69)', () => {
        const mobileNotes: ConversionNote[] = []
        for (let i = 0; i < 80; i++) {
          mobileNotes.push({
            category: 'dropped-mobile-key-still-visible',
            detail: 'usingMobileKey:true collapsed into sendToClientSdk',
            key: `mflag-${i.toString().padStart(3, '0')}`,
          })
        }

        const md = buildMigrationReport(baseData({conversionNotes: mobileNotes, source: 'launchdarkly'}))
        const section = sliceSubsection(md, '### Dropped mobile-key availability (still client-visible)')
        expect(section, 'subsection present').to.not.equal('')

        expect(section).to.include('<details>')
        expect(section).to.match(/80 flag/i)
        expect(section).to.include('mflag-000')
      })

      it('routes dropped-mobile-key-now-server-only into mustFixBeforeCutover (qfg-iv69)', () => {
        const notes: ConversionNote[] = [
          {
            category: 'dropped-mobile-key-now-server-only',
            detail: 'usingMobileKey:true + usingEnvironmentId:false — flag will not reach mobile clients',
            key: 'mobile-only-flag',
          },
        ]
        const followUp = deriveFollowUpFromConversionNotes({mustFixBeforeCutover: [], reviewPostCutover: []}, notes)
        expect(followUp.mustFixBeforeCutover).to.have.length(1)
        expect(followUp.mustFixBeforeCutover[0]).to.match(/mobile-only-flag/)
        expect(followUp.mustFixBeforeCutover[0]).to.match(/mobile/i)
        expect(followUp.reviewPostCutover).to.have.length(0)
      })

      it('renders dropped-mobile-key-now-server-only as un-collapsed per-flag bullets (it is must-fix, not noise)', () => {
        const md = buildMigrationReport(
          baseData({
            conversionNotes: [
              {
                category: 'dropped-mobile-key-now-server-only',
                detail: 'flag will not reach mobile clients',
                key: 'mobile-only-a',
              },
              {
                category: 'dropped-mobile-key-now-server-only',
                detail: 'flag will not reach mobile clients',
                key: 'mobile-only-b',
              },
            ],
            source: 'launchdarkly',
          }),
        )
        const section = sliceSubsection(md, '### Dropped mobile-key availability (now server-only)')
        expect(section, 'subsection present').to.not.equal('')
        expect(section).to.not.include('<details>')
        expect(section).to.include('- `mobile-only-a`')
        expect(section).to.include('- `mobile-only-b`')
      })

      it('renders enriched dropped-prerequisite forward bullets + inverted orphan-parent view (qfg-nb4n)', () => {
        const md = buildMigrationReport(
          baseData({
            conversionNotes: [
              {
                category: 'dropped-prerequisite',
                detail: 'evaluated independently of 2 parent(s)',
                key: 'fx-prereq-multiple',
                prerequisites: [
                  {parentKey: 'fx-prereq-target-bool', variation: 0},
                  {parentKey: 'fx-prereq-target-bool-2', variation: 1},
                ],
              },
              {
                category: 'dropped-prerequisite',
                detail: 'evaluated independently of 1 parent',
                key: 'fx-prereq-single-boolean',
                prerequisites: [{parentKey: 'fx-prereq-target-bool', variation: 0}],
              },
            ],
            source: 'launchdarkly',
          }),
        )

        const start = md.indexOf('### Dropped prerequisites')
        const end = md.indexOf('\n### ', start + 1)
        const section = md.slice(start, end === -1 ? undefined : end)

        // Forward view: child flag + parent variation indices appear together.
        expect(section).to.include('fx-prereq-multiple')
        expect(section).to.include('fx-prereq-target-bool')
        expect(section).to.include('fx-prereq-target-bool-2')
        expect(section).to.match(/variation 0/)
        expect(section).to.match(/variation 1/)
        // Remediation copy is rendered.
        expect(section).to.match(/leading rule|wrap reads|app code/i)

        // Inverted view: an orphan-parent rollup names each parent and its
        // downstream consumers (children that gated on it).
        expect(section).to.match(/orphaned/i)
        // fx-prereq-target-bool is depended on by BOTH children.
        const orphanIdx = section.indexOf('orphaned')
        const orphanBlock = section.slice(orphanIdx)
        expect(orphanBlock).to.include('fx-prereq-target-bool')
        expect(orphanBlock).to.include('fx-prereq-multiple')
        expect(orphanBlock).to.include('fx-prereq-single-boolean')
      })

      it('keeps signal categories (prereqs, individual-targets, unexportable-segments) as un-collapsed per-flag bullets', () => {
        const md = buildMigrationReport(
          baseData({
            conversionNotes: [
              {category: 'dropped-prerequisite', detail: 'prereq dropped', key: 'gated-a'},
              {category: 'dropped-prerequisite', detail: 'prereq dropped', key: 'gated-b'},
              {category: 'individual-target-as-rule', detail: 'targets to rule', key: 'vip-flag'},
              {category: 'unexportable-segment-membership', detail: 'big segment', key: 'big-seg'},
            ],
            source: 'launchdarkly',
          }),
        )
        const section = md.slice(md.indexOf('## Conversion notes'))
        // None of the signal subsections wrap their bullets in <details>.
        const prereqStart = section.indexOf('### Dropped prerequisites')
        const prereqEnd = section.indexOf('\n### ', prereqStart + 1)
        const prereqBody = section.slice(prereqStart, prereqEnd > -1 ? prereqEnd : undefined)
        expect(prereqBody).to.not.include('<details>')
        expect(prereqBody).to.include('- `gated-a`')
        expect(prereqBody).to.include('- `gated-b`')
      })
    })

    describe('Before you cut over (TL;DR — qfg-e8md)', () => {
      it('renders the section before Counts when any signal category is present', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [
              {
                category: 'dropped-prerequisite',
                key: 'gated-flag',
                detail: '1 prerequisite dropped',
              },
            ],
          }),
        )
        expect(md).to.match(/^##\s*Before you cut over/m)
        const beforeIdx = md.indexOf('## Before you cut over')
        const countsIdx = md.indexOf('## Counts')
        expect(beforeIdx).to.be.greaterThan(-1)
        expect(beforeIdx).to.be.lessThan(countsIdx)
      })

      it('lists dropped-prerequisite, rebucketed-rollout, unexportable-segment-membership, and skipped-rule items with counts and example keys', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [
              {category: 'dropped-prerequisite', key: 'fx-prereq-multiple', detail: '2 prerequisite(s) dropped'},
              {category: 'dropped-prerequisite', key: 'fx-prereq-single', detail: '1 prerequisite dropped'},
              {category: 'dropped-prerequisite', key: 'fx-prereq-third', detail: '1 prerequisite dropped'},
              {category: 'rebucketed-rollout', key: 'roll-a', detail: 'rollout'},
              {category: 'rebucketed-rollout', key: 'roll-b', detail: 'rollout'},
              {category: 'unexportable-segment-membership', key: 'fx-seg-big-synced', detail: 'big segment'},
              {category: 'skipped-rule', key: 'op-flag', detail: 'unsupported operator'},
            ],
          }),
        )
        const section = md.slice(md.indexOf('## Before you cut over'), md.indexOf('## Counts'))
        expect(section).to.match(/3 flags lost cross-flag dependencies/)
        expect(section).to.include('fx-prereq-multiple')
        expect(section).to.match(/2 flags will re-bucket users/)
        expect(section).to.match(/1 segment has missing membership/)
        expect(section).to.include('fx-seg-big-synced')
        expect(section).to.match(/1 flag had rules skipped/i)
        expect(section).to.include('op-flag')
      })

      it('includes a "You can ignore" line listing dropped-maintainer and dropped-mobile-key-still-visible counts', () => {
        const maintainerNotes: ConversionNote[] = []
        for (let i = 0; i < 78; i++) {
          maintainerNotes.push({category: 'dropped-maintainer', detail: 'maintainer dropped', key: `flag-${i}`})
        }

        const mobileKeyNotes: ConversionNote[] = []
        for (let i = 0; i < 80; i++) {
          mobileKeyNotes.push({
            category: 'dropped-mobile-key-still-visible',
            detail: 'mobile-key dropped (still visible)',
            key: `mflag-${i}`,
          })
        }

        const md = buildMigrationReport(
          baseData({
            conversionNotes: [
              {category: 'dropped-prerequisite', detail: 'prereq dropped', key: 'gated-flag'},
              ...maintainerNotes,
              ...mobileKeyNotes,
            ],
            source: 'launchdarkly',
          }),
        )
        const section = md.slice(md.indexOf('## Before you cut over'), md.indexOf('## Counts'))
        expect(section).to.match(/you can ignore/i)
        expect(section).to.include('78')
        expect(section).to.include('80')
        expect(section).to.match(/maintainer/i)
        expect(section).to.match(/mobile-key/i)
      })

      it('omits the section entirely when no signal categories are present', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [
              {category: 'dropped-maintainer', key: 'flag-1', detail: 'maintainer dropped'},
              {category: 'individual-target-as-rule', key: 'vip-flag', detail: 'targets to rule'},
            ],
          }),
        )
        expect(md).to.not.match(/Before you cut over/)
      })

      it('omits the section when conversionNotes is undefined', () => {
        const md = buildMigrationReport(baseData())
        expect(md).to.not.match(/Before you cut over/)
      })

      it('omits "You can ignore" line when no informational categories have entries', () => {
        const md = buildMigrationReport(
          baseData({
            source: 'launchdarkly',
            conversionNotes: [{category: 'dropped-prerequisite', key: 'gated-flag', detail: 'prereq dropped'}],
          }),
        )
        const section = md.slice(md.indexOf('## Before you cut over'), md.indexOf('## Counts'))
        expect(section).to.not.match(/you can ignore/i)
      })
    })

    describe('Behavioral differences appendix (qfg-ox7m)', () => {
      it('appends a "Behavioral differences post-cutover" appendix when source is launchdarkly', () => {
        const md = buildMigrationReport(baseData({source: 'launchdarkly'}))
        expect(md).to.match(/^##\s*Behavioral differences post-cutover/m)
      })

      it('omits the appendix for sources that do not define one (launch, unknown)', () => {
        for (const source of ['launch', 'unknown']) {
          const md = buildMigrationReport(baseData({source}))
          expect(md, `source=${source}`).to.not.match(/Behavioral differences post-cutover/)
        }
      })

      it('renders a Flagsmith-specific behavioral-differences appendix when source is flagsmith', () => {
        const md = buildMigrationReport(baseData({source: 'flagsmith'}))
        expect(md).to.match(/^##\s*Behavioral differences post-cutover/m)
        // Mentions the Flagsmith-specific gaps: enabled=false, identity overrides,
        // multivariate bucketing salts, and soft-deleted-features being invisible.
        const appendix = md.slice(md.indexOf('## Behavioral differences post-cutover'))
        expect(appendix).to.match(/enabled=false/)
        expect(appendix).to.match(/identity overrides/i)
        expect(appendix).to.match(/multivariate/i)
        expect(appendix).to.match(/soft-deleted/i)
      })

      it('renders identical appendix content across runs (data-independent)', () => {
        const md1 = buildMigrationReport(baseData({source: 'launchdarkly'}))
        const md2 = buildMigrationReport(
          baseData({
            cleanMappings: [{legacyKey: 'a', quonfigKey: 'a'}],
            counts: {
              configsMigrated: 9,
              environmentsMapped: 9,
              flagsMigrated: 99,
              itemsSkipped: 9,
              logLevelsMigrated: 9,
              schemasMigrated: 9,
              segmentsMigrated: 9,
            },
            source: 'launchdarkly',
          }),
        )
        const sliceAppendix = (md: string): string => md.slice(md.indexOf('## Behavioral differences post-cutover'))
        expect(sliceAppendix(md1)).to.equal(sliceAppendix(md2))
      })

      it('covers the v1 LD gap roster (targets, off toggle, offVariation, mobile keys, maintainer)', () => {
        const md = buildMigrationReport(baseData({source: 'launchdarkly'}))
        const appendix = md.slice(md.indexOf('## Behavioral differences post-cutover'))
        expect(appendix, 'targets/contextTargets').to.match(/contextTargets/)
        expect(appendix, "'off' toggle").to.match(/["'`]off["'`] toggle/)
        expect(appendix, 'offVariation').to.match(/offVariation/)
        expect(appendix, 'mobile SDK keys').to.match(/[Mm]obile SDK keys/)
        expect(appendix, 'maintainer').to.match(/[Mm]aintainer/)
      })

      it('renders the appendix as the final section (after Follow-up checklist)', () => {
        const md = buildMigrationReport(baseData({source: 'launchdarkly'}))
        const followUpIdx = md.indexOf('## Follow-up checklist')
        const appendixIdx = md.indexOf('## Behavioral differences post-cutover')
        expect(followUpIdx).to.be.greaterThan(-1)
        expect(appendixIdx).to.be.greaterThan(followUpIdx)
      })
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
