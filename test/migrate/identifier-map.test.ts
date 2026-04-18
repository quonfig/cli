import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  detectCollisions,
  IdentifierMapCollisionError,
  readIdentifierMap,
  writeIdentifierMap,
} from '../../src/migrate/identifier-map.js'

describe('migrate/identifier-map', () => {
  describe('detectCollisions', () => {
    it('returns no collisions for a unique mapping', () => {
      const map = {'my-flag': 'my_flag', 'other-flag': 'other_flag'}
      expect(detectCollisions(map)).to.deep.equal([])
    })

    it('detects a case-only collision between two quonfig keys', () => {
      const map = {legacyA: 'foo', legacyB: 'FOO'}
      const collisions = detectCollisions(map)
      expect(collisions).to.have.length(1)
      const collision = collisions[0]!
      expect(new Set([collision.quonfigKeyA, collision.quonfigKeyB])).to.deep.equal(
        new Set(['foo', 'FOO']),
      )
      expect(new Set([collision.legacyKeyA, collision.legacyKeyB])).to.deep.equal(
        new Set(['legacyA', 'legacyB']),
      )
    })

    it('is deterministic regardless of insertion order', () => {
      const a = detectCollisions({a: 'FOO', b: 'foo'})
      const b = detectCollisions({b: 'foo', a: 'FOO'})
      expect(a).to.deep.equal(b)
    })

    it('reports all collision pairs when more than two keys collide', () => {
      const map = {a: 'foo', b: 'FOO', c: 'Foo'}
      const collisions = detectCollisions(map)
      // three-way collision → 3 pairs (a,b), (a,c), (b,c)
      expect(collisions).to.have.length(3)
    })

    it('does not flag keys that share a prefix but differ in more than case', () => {
      const map = {a: 'foo_bar', b: 'foo-bar'}
      expect(detectCollisions(map)).to.deep.equal([])
    })
  })

  describe('writeIdentifierMap', () => {
    let tmpdir: string

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'identifier-map-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpdir, {force: true, recursive: true})
    })

    it('writes .qf/identifier-map.json with deterministic key ordering', () => {
      writeIdentifierMap(tmpdir, {'z-flag': 'z_flag', 'a-flag': 'a_flag', 'm-flag': 'm_flag'})
      const written = fs.readFileSync(path.join(tmpdir, '.qf', 'identifier-map.json'), 'utf8')
      // keys must be sorted so the file is stable across runs
      expect(written).to.equal(
        JSON.stringify({'a-flag': 'a_flag', 'm-flag': 'm_flag', 'z-flag': 'z_flag'}, null, 2) + '\n',
      )
    })

    it('creates the .qf directory if it does not exist', () => {
      writeIdentifierMap(tmpdir, {'a-flag': 'a_flag'})
      expect(fs.existsSync(path.join(tmpdir, '.qf', 'identifier-map.json'))).to.equal(true)
    })

    it('throws IdentifierMapCollisionError and writes nothing on case collision', () => {
      expect(() => writeIdentifierMap(tmpdir, {a: 'foo', b: 'FOO'})).to.throw(
        IdentifierMapCollisionError,
      )
      expect(fs.existsSync(path.join(tmpdir, '.qf', 'identifier-map.json'))).to.equal(false)
    })

    it('error message names both colliding legacy and quonfig keys', () => {
      let caught: unknown
      try {
        writeIdentifierMap(tmpdir, {legacyA: 'foo', legacyB: 'FOO'})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(IdentifierMapCollisionError)
      const message = (caught as Error).message
      expect(message).to.include('legacyA')
      expect(message).to.include('legacyB')
      expect(message).to.include('foo')
      expect(message).to.include('FOO')
    })

    it('leaves any pre-existing identifier-map.json untouched on collision', () => {
      const qfDir = path.join(tmpdir, '.qf')
      fs.mkdirSync(qfDir)
      const mapPath = path.join(qfDir, 'identifier-map.json')
      fs.writeFileSync(mapPath, '{"preexisting":"value"}\n')

      expect(() => writeIdentifierMap(tmpdir, {a: 'foo', b: 'FOO'})).to.throw(
        IdentifierMapCollisionError,
      )
      expect(fs.readFileSync(mapPath, 'utf8')).to.equal('{"preexisting":"value"}\n')
    })
  })

  describe('readIdentifierMap', () => {
    let tmpdir: string

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'identifier-map-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpdir, {force: true, recursive: true})
    })

    it('returns null if the file does not exist', () => {
      expect(readIdentifierMap(tmpdir)).to.equal(null)
    })

    it('round-trips a written identifier map', () => {
      const map = {'my-flag': 'my_flag', 'other-flag': 'other_flag'}
      writeIdentifierMap(tmpdir, map)
      expect(readIdentifierMap(tmpdir)).to.deep.equal(map)
    })
  })
})
