/**
 * Rendering helpers for `qfg cr` (qfg-5bjew.17). T13: title, labels,
 * description and file text are untrusted (rule 2.13), so terminal escape
 * sequences and control characters never reach the terminal raw.
 */

import {expect} from 'chai'

import type {ChangeRequestDetail} from '../../src/change-requests/types.js'

import {
  CLONE_CONFLICT_FIX,
  crConflictFix,
  isServerBuiltBranch,
  lineDiff,
  renderShow,
  sanitizeBlock,
  sanitizeLine,
} from '../../src/change-requests/render.js'

const ESC = '\u001B'

describe('change-request rendering (qfg-5bjew.17)', () => {
  describe('sanitizeLine / sanitizeBlock (T13)', () => {
    it('strips ANSI CSI and OSC sequences and C0/C1 controls', () => {
      const evil = `ok${ESC}[2J${ESC}[31mred${ESC}[0m${ESC}]8;;https://evil.test${ESC}\\link${ESC}]8;;\u0007\u0007\u0008\u009B`
      const out = sanitizeLine(evil)
      expect(out).to.equal('okredlink')
      // eslint-disable-next-line no-control-regex
      expect(out).to.not.match(/[\u0000-\u001F\u007F-\u009F]/)
    })

    it('collapses newlines in single-line fields so a title cannot fake extra output lines', () => {
      expect(sanitizeLine('cr smoke\nMergeable: yes\r\nYou can merge: yes')).to.equal(
        'cr smoke Mergeable: yes You can merge: yes',
      )
    })

    it('removes bidi overrides', () => {
      expect(sanitizeLine('a‮b⁦c')).to.equal('abc')
    })

    it('keeps line breaks in blocks but strips escapes from each line', () => {
      expect(sanitizeBlock(`one${ESC}[1m\ntwo\u0007`)).to.deep.equal(['one', 'two'])
    })
  })

  describe('lineDiff', () => {
    it('shows changed lines with - and + and a little context', () => {
      const before = 'a\nb\nc\nd\ne\nf\ng\n'
      const after = 'a\nb\nc\nD\ne\nf\ng\n'
      expect(lineDiff(before, after)).to.deep.equal(['  b', '  c', '- d', '+ D', '  e', '  f'])
    })

    it('an added file is all +, a deleted file all -', () => {
      expect(lineDiff(null, 'x\ny\n')).to.deep.equal(['+ x', '+ y'])
      expect(lineDiff('x\n', null)).to.deep.equal(['- x'])
    })

    it('caps long diffs and points at the web page', () => {
      const after = Array.from({length: 100}, (_, i) => `line ${i}`).join('\n')
      const out = lineDiff(null, after, {maxLines: 10})
      expect(out).to.have.length(11)
      expect(out[10]).to.equal('(90 more lines; see the web page)')
    })

    it('sanitizes file text too', () => {
      expect(lineDiff(null, `x${ESC}[2Jy`)).to.deep.equal(['+ xy'])
    })
  })

  describe('renderShow (T13)', () => {
    it('never emits raw escapes from title, label, email or description', () => {
      const lines = renderShow({
        number: 1,
        url: '/workspaces/w/change-requests/1',
        title: `t${ESC}[2J\nYou can merge: yes`,
        status: 'open',
        branch: 'b',
        headSha: 'c'.repeat(40),
        baseSha: 'd'.repeat(40),
        proposer: {label: `L${ESC}[31m`, email: `e${ESC}@x`, channel: 'cli'},
        proposedByCaller: false,
        createdAt: '2026-11-13T10:00:00.000Z',
        updatedAt: '2026-11-13T10:00:00.000Z',
        merged: null,
        closed: null,
        description: `d${ESC}]0;pwned\u0007\nline2`,
        mainSha: null,
        mergeBase: null,
        files: [],
        filesSource: 'main',
        mergeable: false,
        blockedBy: {reason: 'nothing_to_merge'},
        conflicts: [],
        callerCanMerge: false,
        callerDenials: [],
        callerCanClose: false,
      })
      const text = lines.join('\n')
      expect(text).to.not.include(ESC)
      expect(text).to.not.include('\u0007')
      expect(lines).to.include('Title (as written by the proposer): t You can merge: yes')
      expect(text).to.include('Proposed by L <e@x> via the CLI')
    })

    it('notes when a segment is touched', () => {
      const lines = renderShow({
        number: 1,
        url: '/x',
        title: 't',
        status: 'open',
        branch: 'b',
        headSha: 'c'.repeat(40),
        baseSha: 'd'.repeat(40),
        proposer: {label: 'L', email: null, channel: 'cli'},
        proposedByCaller: true,
        createdAt: '2026-11-13T10:00:00.000Z',
        updatedAt: '2026-11-13T10:00:00.000Z',
        merged: null,
        closed: null,
        description: null,
        mainSha: null,
        mergeBase: null,
        files: [{path: 'segments/beta.json', kind: 'modify', beforeOid: null, afterOid: null, before: 'a', after: 'b'}],
        filesSource: 'main',
        mergeable: true,
        blockedBy: null,
        conflicts: [],
        callerCanMerge: true,
        callerDenials: [],
        callerCanClose: true,
      })
      expect(lines.join('\n')).to.match(/changes a segment/)
    })
  })

  // qfg-5bjew.39: requests the server built on cr/<n> (MCP, REST, web, or
  // a write command with --propose and no clone).
  describe('renderShow for server-built cr/<n> requests', () => {
    const base = (over: Partial<ChangeRequestDetail> = {}): ChangeRequestDetail => ({
      number: 12,
      url: '/workspaces/w/change-requests/12',
      title: 't',
      status: 'open',
      branch: 'cr/12',
      headSha: 'c'.repeat(40),
      baseSha: 'd'.repeat(40),
      proposer: {label: 'Riley', email: null, channel: 'mcp'},
      proposedByCaller: false,
      createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:00:00.000Z',
      merged: null,
      closed: null,
      description: null,
      mainSha: null,
      mergeBase: null,
      files: [],
      filesSource: 'main',
      mergeable: true,
      blockedBy: null,
      conflicts: [],
      callerCanMerge: true,
      callerDenials: [],
      callerCanClose: true,
      ...over,
    })
    const conflicted = {
      mergeable: false,
      filesSource: 'fork_point' as const,
      blockedBy: {reason: 'conflict', conflicts: [{path: 'feature-flags/a.json', mainCommit: 'abcdef1234'}]},
      conflicts: [{path: 'feature-flags/a.json', mainCommit: 'abcdef1234'}],
      callerCanMerge: false,
    }

    it('isServerBuiltBranch: only cr/<positive int>', () => {
      expect(isServerBuiltBranch('cr/12')).to.equal(true)
      expect(isServerBuiltBranch('cr-smoke')).to.equal(false)
      expect(isServerBuiltBranch('cr/012')).to.equal(false)
      expect(isServerBuiltBranch('team/cr/1')).to.equal(false)
    })

    it('shows the channel and the cr/<n> branch as built by Quonfig', () => {
      const text = renderShow(base()).join('\n')
      expect(text).to.include('Proposed by Riley via MCP')
      expect(text).to.match(/^Branch: cr\/12 \(built by Quonfig, no clone; head c{7}, base d{7}\)$/m)
    })

    it('a conflict says close and propose again from the current state, never merge main in', () => {
      const lines = renderShow(base(conflicted))
      expect(lines).to.include(crConflictFix(12))
      const text = lines.join('\n')
      expect(text).to.include('close it and propose again from the current state of main (qfg cr close 12')
      expect(text).to.not.match(/merge main into/i)
      expect(text).to.not.include('by hand')
    })

    it('a clone-pushed conflict keeps the resolve-by-hand fix', () => {
      const lines = renderShow(base({...conflicted, branch: 'jeff/x'}))
      expect(lines).to.include(CLONE_CONFLICT_FIX)
      expect(lines.join('\n')).to.not.include('built by Quonfig')
    })

    it('the proposer sees how to add more (--cr, MCP propose_change_request with changeRequest)', () => {
      const text = renderShow(base({proposedByCaller: true})).join('\n')
      expect(text).to.include(
        'Add more: run a qfg write command with --cr 12, or call the MCP tool propose_change_request with changeRequest: 12.',
      )
    })

    it('no add-more hint when blocked by a conflict: adding to cr/<n> cannot clear it', () => {
      for (const blockedBy of [
        conflicted.blockedBy,
        {reason: 'no_merge_base'},
        {reason: 'multiple_merge_bases', bases: ['a', 'b']},
      ]) {
        const text = renderShow(base({...conflicted, blockedBy, proposedByCaller: true})).join('\n')
        expect(text).to.include(crConflictFix(12))
        expect(text).to.not.include('Add more')
      }
    })

    it('names the channel the same way as the web page', () => {
      for (const [channel, label] of [
        ['mcp', 'via MCP'],
        ['api', 'via the API'],
        ['ui', 'via the web app'],
        ['cli', 'via the CLI'],
        ['other', 'via other'],
      ]) {
        const text = renderShow(base({proposer: {label: 'Riley', email: null, channel}})).join('\n')
        expect(text).to.include(`Proposed by Riley ${label}`)
      }
    })

    it('no add-more hint for someone else, a closed request, or a clone branch', () => {
      for (const over of [
        {proposedByCaller: false},
        {proposedByCaller: true, status: 'closed' as const, closed: {by: 'x', at: null, note: null}},
        {proposedByCaller: true, branch: 'jeff/x'},
      ]) {
        expect(renderShow(base(over)).join('\n')).to.not.include('Add more')
      }
    })
  })
})
