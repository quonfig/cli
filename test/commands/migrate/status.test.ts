import {expect, test} from '@oclif/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('migrate status', () => {
  let tmpdir: string
  let prevCwd: string

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-status-test-'))
    prevCwd = process.cwd()
    process.chdir(tmpdir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpdir, {force: true, recursive: true})
  })

  const writeState = (dir: string, payload: Record<string, unknown>) => {
    const qfDir = path.join(dir, '.qf')
    fs.mkdirSync(qfDir, {recursive: true})
    fs.writeFileSync(
      path.join(qfDir, 'import-state.json'),
      JSON.stringify(payload, null, 2) + '\n',
    )
  }

  const writeFlag = (dir: string, key: string) => {
    const flagsDir = path.join(dir, 'feature-flags')
    fs.mkdirSync(flagsDir, {recursive: true})
    fs.writeFileSync(path.join(flagsDir, `${key}.json`), '{}\n')
  }

  const writeSegment = (dir: string, key: string) => {
    const segmentsDir = path.join(dir, 'segments')
    fs.mkdirSync(segmentsDir, {recursive: true})
    fs.writeFileSync(path.join(segmentsDir, `${key}.json`), '{}\n')
  }

  const writeWorkspaceJson = (dir: string, environments: string[]) => {
    fs.writeFileSync(
      path.join(dir, 'quonfig.json'),
      JSON.stringify({environments}, null, 2) + '\n',
    )
  }

  describe('when no state file exists', () => {
    test
      .stdout()
      .command(['migrate:status'])
      .it('prints a helpful message pointing at qfg migrate', (ctx) => {
        expect(ctx.stdout).to.contain('No migration state found')
        expect(ctx.stdout).to.match(/qfg migrate --from/)
      })

    test
      .stdout()
      .command(['migrate:status', '--json'])
      .it('returns structured JSON with found=false', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output.found).to.equal(false)
        expect(output.message).to.match(/no migration state/i)
      })
  })

  describe('when state file exists', () => {
    beforeEach(() => {
      writeState(tmpdir, {
        lastProcessedAt: 1_700_000_000_000,
        source: 'launch',
        sourceWorkspaceId: 'proj-abc',
      })
      writeFlag(tmpdir, 'my-flag')
      writeFlag(tmpdir, 'other-flag')
      writeSegment(tmpdir, 'beta-users')
      writeWorkspaceJson(tmpdir, ['production', 'staging', 'development'])
    })

    test
      .stdout()
      .command(['migrate:status'])
      .it('prints source, workspace id, counts, and a Next line', (ctx) => {
        expect(ctx.stdout).to.match(/Source:\s+launch/)
        expect(ctx.stdout).to.match(/Source workspace:\s+proj-abc/)
        expect(ctx.stdout).to.match(/Flags:\s+2/)
        expect(ctx.stdout).to.match(/Segments:\s+1/)
        expect(ctx.stdout).to.match(/Environments:\s+3/)
        // ISO 8601 date for the lastProcessedAt timestamp (2023-11-14…)
        expect(ctx.stdout).to.contain('2023-11-14')
        expect(ctx.stdout).to.match(/^Next:/m)
      })

    test
      .stdout()
      .command(['migrate:status', '--json'])
      .it('returns structured JSON payload', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output.found).to.equal(true)
        expect(output.source).to.equal('launch')
        expect(output.sourceWorkspaceId).to.equal('proj-abc')
        expect(output.lastProcessedAt).to.equal(1_700_000_000_000)
        expect(output.lastProcessedAtIso).to.contain('2023-11-14')
        expect(output.counts).to.deep.equal({
          environments: 3,
          flags: 2,
          segments: 1,
        })
        expect(output.next).to.be.a('string')
        expect(output.dir).to.be.a('string')
      })

    test
      .stdout()
      .command(['migrate:status', '--dir', '.'])
      .it('honors --dir flag', (ctx) => {
        expect(ctx.stdout).to.match(/Source:\s+launch/)
      })
  })

  describe('when --dir points at a workspace that has no state', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(tmpdir, 'empty-ws'))
    })

    test
      .stdout()
      .command(['migrate:status', '--dir', 'empty-ws'])
      .it('prints the helpful no-state message without crashing', (ctx) => {
        expect(ctx.stdout).to.contain('No migration state found')
      })
  })

  describe('when state file has only required source field', () => {
    beforeEach(() => {
      writeState(tmpdir, {source: 'launch'})
    })

    test
      .stdout()
      .command(['migrate:status', '--json'])
      .it('handles missing optional fields gracefully', (ctx) => {
        const output = JSON.parse(ctx.stdout)
        expect(output.found).to.equal(true)
        expect(output.source).to.equal('launch')
        expect(output.sourceWorkspaceId).to.equal(null)
        expect(output.lastProcessedAt).to.equal(null)
        expect(output.counts.flags).to.equal(0)
        expect(output.counts.segments).to.equal(0)
        expect(output.counts.environments).to.equal(0)
      })
  })
})
