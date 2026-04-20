import {expect} from 'chai'

import {summarizeDiff, type FileDelta} from '../../src/push/diff-summary.js'

describe('summarizeDiff', () => {
  describe('grouping + counts', () => {
    it('returns zero counts and not-destructive for an empty delta list', () => {
      const summary = summarizeDiff([])

      expect(summary.byGroup).to.deep.equal({})
      expect(summary.totals).to.deep.equal({added: 0, deleted: 0, filesTouched: 0, modified: 0})
      expect(summary.isDestructive).to.equal(false)
      expect(summary.destructiveReasons).to.deep.equal([])
    })

    it('groups files by their top-level directory and counts per kind', () => {
      const deltas: FileDelta[] = [
        {kind: 'added', path: 'configs/pricing.json'},
        {kind: 'added', path: 'configs/billing.json'},
        {kind: 'modified', path: 'configs/flags.json'},
        {kind: 'deleted', path: 'feature-flags/old-flag.json'},
        {kind: 'added', path: 'segments/alpha.json'},
        {kind: 'modified', path: 'schemas/user.json'},
        {kind: 'deleted', path: 'schemas-protected/admin.json'},
        {kind: 'modified', path: 'log-levels/root.json'},
      ]

      const summary = summarizeDiff(deltas)

      expect(summary.byGroup.configs).to.deep.equal({added: 2, deleted: 0, modified: 1})
      expect(summary.byGroup['feature-flags']).to.deep.equal({added: 0, deleted: 1, modified: 0})
      expect(summary.byGroup.segments).to.deep.equal({added: 1, deleted: 0, modified: 0})
      expect(summary.byGroup.schemas).to.deep.equal({added: 0, deleted: 0, modified: 1})
      expect(summary.byGroup['schemas-protected']).to.deep.equal({added: 0, deleted: 1, modified: 0})
      expect(summary.byGroup['log-levels']).to.deep.equal({added: 0, deleted: 0, modified: 1})

      expect(summary.totals).to.deep.equal({added: 3, deleted: 2, filesTouched: 8, modified: 3})
      expect(summary.isDestructive).to.equal(false)
    })

    it('routes repo-root files and unknown top-level dirs into the `other` group', () => {
      const deltas: FileDelta[] = [
        {kind: 'modified', path: 'quonfig.json'}, // repo root, no slash
        {kind: 'added', path: 'weird-new-dir/thing.json'}, // unknown top-level
      ]

      const summary = summarizeDiff(deltas)

      expect(summary.byGroup.other).to.deep.equal({added: 1, deleted: 0, modified: 1})
      expect(summary.totals.filesTouched).to.equal(2)
    })
  })

  describe('destructive heuristics', () => {
    it('flags destructive when total deletes >= 10', () => {
      const deltas: FileDelta[] = Array.from({length: 10}, (_, i) => ({
        kind: 'deleted' as const,
        path: `configs/old-${i}.json`,
      }))

      const summary = summarizeDiff(deltas)

      expect(summary.isDestructive).to.equal(true)
      expect(summary.destructiveReasons.some((r) => r.includes('10+ deletes'))).to.equal(true)
      expect(summary.destructiveReasons.some((r) => r.includes('12'))).to.equal(false) // the count should be 10, not 12
    })

    it('does not flag delete-count when deletes < 10', () => {
      const deltas: FileDelta[] = Array.from({length: 9}, (_, i) => ({
        kind: 'deleted' as const,
        path: `configs/old-${i}.json`,
      }))

      const summary = summarizeDiff(deltas)

      expect(summary.isDestructive).to.equal(false)
      expect(summary.destructiveReasons).to.deep.equal([])
    })

    it('flags destructive with the unpinned reason when opts.unpinned is true', () => {
      const deltas: FileDelta[] = [
        {kind: 'deleted', path: 'configs/a.json'},
        {kind: 'deleted', path: 'configs/b.json'},
      ]

      const summary = summarizeDiff(deltas, {unpinned: true})

      expect(summary.isDestructive).to.equal(true)
      expect(summary.destructiveReasons.some((r) => r.toLowerCase().includes('unpinned'))).to.equal(true)
    })

    it('flags destructive when deletes are >= 25% of remote files', () => {
      const deltas: FileDelta[] = Array.from({length: 5}, (_, i) => ({
        kind: 'deleted' as const,
        path: `configs/old-${i}.json`,
      }))

      const summary = summarizeDiff(deltas, {totalFilesInRemote: 20})

      expect(summary.isDestructive).to.equal(true)
      expect(summary.destructiveReasons.some((r) => r.includes('25%') || r.includes('5/20'))).to.equal(true)
    })

    it('does not flag the percent rule when the ratio is strictly under 25%', () => {
      // 4 deletes / 20 remote = 20% — below threshold
      const deltas: FileDelta[] = Array.from({length: 4}, (_, i) => ({
        kind: 'deleted' as const,
        path: `configs/old-${i}.json`,
      }))

      const summary = summarizeDiff(deltas, {totalFilesInRemote: 20})

      expect(summary.isDestructive).to.equal(false)
    })

    it('records multiple reasons when multiple heuristics fire', () => {
      const deltas: FileDelta[] = Array.from({length: 12}, (_, i) => ({
        kind: 'deleted' as const,
        path: `configs/old-${i}.json`,
      }))

      const summary = summarizeDiff(deltas, {totalFilesInRemote: 40, unpinned: true})

      expect(summary.isDestructive).to.equal(true)
      // 12 >= 10 → count rule; 12/40 = 30% → percent rule; unpinned → unpinned rule
      expect(summary.destructiveReasons.length).to.be.greaterThanOrEqual(3)
    })
  })

  describe('renderText', () => {
    it('renders a single-group small change with header + totals, no warning', () => {
      const deltas: FileDelta[] = [
        {kind: 'added', path: 'configs/pricing.json'},
        {kind: 'modified', path: 'configs/billing.json'},
      ]

      const text = summarizeDiff(deltas).renderText({
        branch: 'main',
        localDir: '.',
        repoUrl: 'https://git.quonfig.com/acme/config.git',
        workspaceSlug: 'acme',
      })

      expect(text).to.include('Pushing to workspace:')
      expect(text).to.include('acme')
      expect(text).to.include('https://git.quonfig.com/acme/config.git')
      expect(text).to.include('Branch:')
      expect(text).to.include('main')
      expect(text).to.include('Local dir:')
      expect(text).to.include('configs/')
      expect(text).to.include('+1')
      expect(text).to.include('~1')
      expect(text).to.include('-0')
      expect(text).to.include('Total: 1 new files, 1 modified, 0 deleted')
      expect(text.toLowerCase()).to.not.include('warning')

      // Only groups with non-zero counts appear.
      expect(text).to.not.include('feature-flags/')
      expect(text).to.not.include('segments/')
      expect(text).to.not.include('schemas/')

      // ASCII only — no unicode box chars.
      expect(/[\u2500-\u257F]/.test(text)).to.equal(false)
    })

    it('renders multi-group change with a destructive WARNING block before the total', () => {
      const deltas: FileDelta[] = [
        {kind: 'added', path: 'configs/a.json'},
        {kind: 'added', path: 'configs/b.json'},
        {kind: 'added', path: 'configs/c.json'},
        {kind: 'modified', path: 'configs/d.json'},
        {kind: 'modified', path: 'configs/e.json'},
        {kind: 'added', path: 'feature-flags/new.json'},
        ...Array.from({length: 10}, (_, i) => ({
          kind: 'deleted' as const,
          path: `feature-flags/old-${i}.json`,
        })),
      ]

      const text = summarizeDiff(deltas).renderText({
        branch: 'main',
        localDir: './our-config',
        repoUrl: 'https://git.quonfig.com/acme/config.git',
        workspaceSlug: 'acme',
      })

      const warningIdx = text.indexOf('WARNING:')
      const totalIdx = text.indexOf('Total:')
      expect(warningIdx).to.be.greaterThan(-1)
      expect(totalIdx).to.be.greaterThan(-1)
      expect(warningIdx).to.be.lessThan(totalIdx)

      expect(text).to.include('configs/')
      expect(text).to.include('feature-flags/')
      expect(text).to.include('Total: 4 new files, 2 modified, 10 deleted')

      // WARNING section should include the delete-count reason.
      expect(text).to.match(/WARNING:[\S\s]*10\+ deletes/)
    })

    it('renders <unknown> placeholders when caller opts are missing, and tolerates no opts at all', () => {
      const deltas: FileDelta[] = [{kind: 'added', path: 'configs/a.json'}]
      const summary = summarizeDiff(deltas)

      const text = summary.renderText()
      expect(text).to.not.include('undefined')
      expect(text).to.include('<unknown>')
      // default branch/localDir fallbacks still render sensibly
      expect(text).to.include('Branch:')
      expect(text).to.include('Local dir:')
    })

    it('includes the unpinned reason in the warning when opts.unpinned is true', () => {
      const deltas: FileDelta[] = [{kind: 'added', path: 'configs/a.json'}]
      const summary = summarizeDiff(deltas, {unpinned: true})

      const text = summary.renderText({workspaceSlug: 'acme'})

      expect(text).to.include('WARNING:')
      expect(text.toLowerCase()).to.include('unpinned')
    })
  })
})
