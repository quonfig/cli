import {expect} from 'chai'

import {normalizeImportedWeights} from '../../src/migrate/quonfig-target/weights.js'

describe('normalizeImportedWeights (qfg-wis6.11)', () => {
  it('imports all-equal weights verbatim (the even-split encoding)', () => {
    expect(normalizeImportedWeights([1, 1])).to.be.null
    expect(normalizeImportedWeights([1, 1, 1])).to.be.null
    expect(normalizeImportedWeights([100, 100, 100])).to.be.null
  })

  it('imports percent-scale sums verbatim', () => {
    expect(normalizeImportedWeights([50_000, 50_000])).to.be.null
    expect(normalizeImportedWeights([33_333, 33_333, 33_334])).to.be.null
    expect(normalizeImportedWeights([100_000, 0])).to.be.null
  })

  it('normalizes a non-equal relative ratio to sum 100000', () => {
    const result = normalizeImportedWeights([3, 1])
    expect(result?.weights).to.deep.equal([75_000, 25_000])
    expect(result?.detail).to.include('[3, 1]')
    expect(result?.detail).to.include('100000')
  })

  it('uses largest remainder with ties to the earliest index', () => {
    // 1/1/4: exact shares 16666.67/16666.67/66666.67 — the two missing
    // units go to the two earliest of the equal fractions.
    const result = normalizeImportedWeights([1, 1, 4])
    expect(result?.weights).to.deep.equal([16_667, 16_667, 66_666])
    expect(result?.weights.reduce((a, b) => a + b, 0)).to.equal(100_000)
  })

  it('turns a zero total into an even split of ones', () => {
    const result = normalizeImportedWeights([0, 0])
    expect(result?.weights).to.deep.equal([1, 1])
    expect(result?.detail).to.include('zero total')
  })

  it('returns null for an empty list (caught by verify elsewhere)', () => {
    expect(normalizeImportedWeights([])).to.be.null
  })

  it('normalizes the Form Health shape', () => {
    const result = normalizeImportedWeights([100_000, 80_000])
    expect(result?.weights).to.deep.equal([55_556, 44_444])
  })
})
