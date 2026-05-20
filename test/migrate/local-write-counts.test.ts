import {expect} from 'chai'

import {buildMigrationCommitMessage, buildMigrationCounts} from '../../src/migrate/local-write.js'

describe('buildMigrationCounts (qfg-7eig)', () => {
  it('counts each live path by type-dir, not by source change-event count', () => {
    const livePaths = [
      'feature-flags/patient.faq.show-faq.json',
      'feature-flags/patient.scheduling.banner.json',
      'configs/patient.faq.json',
      'configs/patient.faq.appointments.json',
      'configs/patient.faq.other.json',
      'segments/patients.onboarding.json',
      'schemas/patient-schema.json',
      'log-levels/log-level.app.json',
    ]
    const counts = buildMigrationCounts(livePaths, 4, 0)
    expect(counts.flagsMigrated).to.equal(2)
    expect(counts.configsMigrated).to.equal(3)
    expect(counts.segmentsMigrated).to.equal(1)
    expect(counts.schemasMigrated).to.equal(1)
    expect(counts.logLevelsMigrated).to.equal(1)
    expect(counts.environmentsMapped).to.equal(4)
    expect(counts.itemsSkipped).to.equal(0)
  })

  it('returns zeros when no files were written', () => {
    const counts = buildMigrationCounts([], 0, 0)
    expect(counts.flagsMigrated).to.equal(0)
    expect(counts.configsMigrated).to.equal(0)
    expect(counts.segmentsMigrated).to.equal(0)
    expect(counts.schemasMigrated).to.equal(0)
    expect(counts.logLevelsMigrated).to.equal(0)
  })

  it('preserves environmentsMapped and itemsSkipped from caller', () => {
    const counts = buildMigrationCounts(['feature-flags/a.json'], 7, 16)
    expect(counts.environmentsMapped).to.equal(7)
    expect(counts.itemsSkipped).to.equal(16)
  })

  it('ignores paths that do not match a known type-dir', () => {
    const counts = buildMigrationCounts(['quonfig.json', 'README.md', '.qf/MIGRATION_REPORT.md'], 0, 0)
    expect(counts.flagsMigrated).to.equal(0)
    expect(counts.configsMigrated).to.equal(0)
  })
})

describe('buildMigrationCommitMessage (qfg-7eig)', () => {
  it('summarizes only non-zero counts', () => {
    const msg = buildMigrationCommitMessage('launch', {
      configsMigrated: 142,
      environmentsMapped: 4,
      flagsMigrated: 166,
      itemsSkipped: 16,
      logLevelsMigrated: 0,
      schemasMigrated: 4,
      segmentsMigrated: 1,
    })
    expect(msg).to.equal('migrator: imported 166 flag(s), 142 config(s), 1 segment(s), 4 schema(s) from launch')
    expect(msg).to.not.match(/log-level/)
    expect(msg).to.not.match(/5332/)
  })

  it('handles zero-everything (no objects produced)', () => {
    const msg = buildMigrationCommitMessage('launch', {
      configsMigrated: 0,
      environmentsMapped: 0,
      flagsMigrated: 0,
      itemsSkipped: 0,
      logLevelsMigrated: 0,
      schemasMigrated: 0,
      segmentsMigrated: 0,
    })
    expect(msg).to.equal('migrator: imported no objects from launch')
  })
})
