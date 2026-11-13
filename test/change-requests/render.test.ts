/**
 * Rendering helpers for `qfg cr` (qfg-5bjew.17). T13: title, labels,
 * description and file text are untrusted (rule 2.13), so terminal escape
 * sequences and control characters never reach the terminal raw.
 */

import {expect} from 'chai'

import {lineDiff, renderShow, sanitizeBlock, sanitizeLine} from '../../src/change-requests/render.js'

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
      expect(text).to.include('Proposed by L <e@x> via cli')
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
})
