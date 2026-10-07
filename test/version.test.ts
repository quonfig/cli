import {expect} from 'chai'
import {readFileSync} from 'node:fs'

import cliVersion from '../src/version.js'

// src/version.ts is the version the CLI reports (clientVersion, User-Agent). It is generated from
// package.json by scripts/generate-version.mjs, which `yarn build` runs. Yarn 4 skips `pre*`
// scripts, so a `prebuild` hook never fired and the stamp only matched when a release commit
// edited src/version.ts by hand.
describe('version stamp', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  it('src/version.ts matches the package.json version', () => {
    expect(cliVersion).to.equal(pkg.version)
  })
})
