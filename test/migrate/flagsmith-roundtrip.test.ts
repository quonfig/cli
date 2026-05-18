import {Quonfig} from '@quonfig/node'
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  segmentOutputPath,
  translateFeature,
  translateSegment,
} from '../../src/migrate/sources/flagsmith/translate.js'
import type {
  FlagsmithFeatureWithStates,
  FlagsmithSegment,
  FlagsmithTag,
} from '../../src/migrate/sources/flagsmith/types.js'

/**
 * The Flagsmith converter round-trip tests (plan §6.1 step 4).
 *
 * The golden tests (`flagsmith-golden.test.ts`) prove the converter emits a
 * specific *structure*. This suite proves that structure is *semantically*
 * correct: convert a raw fixture → write it into a datadir workspace → load
 * it with the in-repo sdk-node SDK → evaluate against known contexts →
 * assert the evaluated value matches what Flagsmith itself would have served
 * for that same feature, environment, and identity.
 *
 * This catches drift the structural diff misses. The Flagsmith equivalent of
 * LD's "negated comparison + missing attribute" trap is the **`enabled=false`
 * semantics** (D-F1, plan §5.2) — a string-typed flag with `enabled=false`
 * MUST evaluate to its stored value (not `false`, which is what a sloppy
 * reader of the Flagsmith API would assume).
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'flagsmith')
const RAW_DIR = join(FIXTURE_DIR, 'raw')
/**
 * Segments to copy into the workspace alongside the curated feature set:
 *   - the two segments referenced by the segov/idov fixtures
 *   - one segment per operator-family case under test below; the converter
 *     translates them as plain `segment` Quonfig configs that the SDK can
 *     evaluate as bool flags via `getBool(<seg-key>, context)`.
 */
const SEGMENT_FIXTURE_KEYS = [
  'fx-seg-single-condition',
  'fx-seg-and-within-rule',
  'fx-op-equal',
  'fx-op-greater-than',
  'fx-op-regex',
  'fx-op-in',
  'fx-op-is-set',
  'fx-op-semver-greater',
]

/** Environments present in the round-trip fixture corpus (see _snapshot-meta.json). */
const ENVIRONMENTS = ['development', 'production']

interface SnapshotMeta {
  envNameByApiKey: Record<string, string>
  segmentNameById: Record<string, string>
  tags: FlagsmithTag[]
}

function loadMeta(): SnapshotMeta {
  return JSON.parse(readFileSync(join(RAW_DIR, '_snapshot-meta.json'), 'utf8')) as SnapshotMeta
}

function loadFeatureBundle(fixture: string): FlagsmithFeatureWithStates {
  return JSON.parse(readFileSync(join(RAW_DIR, `${fixture}.json`), 'utf8')) as FlagsmithFeatureWithStates
}

function loadSegment(fixture: string): FlagsmithSegment {
  return JSON.parse(readFileSync(join(RAW_DIR, `${fixture}.json`), 'utf8')) as FlagsmithSegment
}

const cleanupDirs: string[] = []

/**
 * Convert the named feature fixtures (plus a small fixed set of segments
 * referenced by the curated set) and lay them out as a datadir workspace
 * the sdk-node SDK can load. Returns the temp dir path; cleanup is
 * registered via `cleanupDirs`.
 */
function buildDatadir(featureFixtures: string[]): string {
  const meta = loadMeta()
  const envNameByApiKey = new Map(Object.entries(meta.envNameByApiKey))
  const segmentNameById = new Map(Object.entries(meta.segmentNameById).map(([k, v]) => [Number(k), v]))

  const dir = mkdtempSync(join(tmpdir(), 'flagsmith-roundtrip-'))
  cleanupDirs.push(dir)

  writeFileSync(join(dir, 'quonfig.json'), JSON.stringify({environments: ENVIRONMENTS}, null, 2) + '\n')
  mkdirSync(join(dir, 'feature-flags'), {recursive: true})
  mkdirSync(join(dir, 'segments'), {recursive: true})

  const report = new ConversionReport()
  for (const fixture of featureFixtures) {
    const bundle = loadFeatureBundle(fixture)
    const quonfig = translateFeature(bundle, report, {envNameByApiKey, segmentNameById, tags: meta.tags})
    writeFileSync(join(dir, flagOutputPath(bundle.feature.name)), JSON.stringify(quonfig, null, 2) + '\n')
  }

  // Segments referenced by curated segov features need to be present in the
  // workspace too, else IN_SEG criteria evaluate against nothing.
  for (const fixture of SEGMENT_FIXTURE_KEYS) {
    const seg = loadSegment(fixture)
    const quonfig = translateSegment(seg, report)
    writeFileSync(join(dir, segmentOutputPath(seg.name)), JSON.stringify(quonfig, null, 2) + '\n')
  }

  return dir
}

async function makeClient(datadir: string, environment: string): Promise<Quonfig> {
  const client = new Quonfig({datadir, enablePolling: false, enableSSE: false, environment})
  await client.init()
  return client
}

/**
 * Build a Quonfig context. The Flagsmith converter emits trait property names
 * verbatim (e.g. `plan`, `email`, `app_version`) without a `kind.` prefix —
 * Quonfig resolves those against `contexts[""]` (the unnamed kind, see
 * sdk-node/contextLookup). The identifier (used by identity overrides) keys
 * off `user.key`, so we always wire `user.key` for the identity dimension.
 */
function ctx(opts: {
  identifier?: string
  traits?: Record<string, boolean | number | string | undefined>
}): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  if (opts.traits) {
    out[''] = {}
    for (const [k, v] of Object.entries(opts.traits)) {
      if (v !== undefined) out[''][k] = v
    }
  }
  out.user = {key: opts.identifier ?? 'anon-user'}
  return out
}

describe('migrate/sources/flagsmith — converter sdk-node round-trip', () => {
  const FIXTURES = [
    'fx-value-boolean-on',
    'fx-value-boolean-off',
    'fx-value-string-basic',
    'fx-value-string-with-disabled',
    'fx-value-integer-positive',
    'fx-mv-string-3way',
    'fx-segov-single',
    'fx-segov-changes-value',
    'fx-idov-single',
    'fx-idov-and-segov-conflict',
  ]
  let datadir: string

  before(() => {
    datadir = buildDatadir(FIXTURES)
  })

  after(() => {
    for (const dir of cleanupDirs) rmSync(dir, {force: true, recursive: true})
  })

  describe('fx-value-boolean-on — value-less Flagsmith feature → empty string in both envs', () => {
    // The live Flagsmith fixture has `default_enabled=true` with no value payload
    // (all `*_value` fields null). The converter has no signal to infer bool type
    // and falls back to valueType: string with value "". The bool semantics of
    // `enabled=true` are lost — a converter follow-up could detect this shape
    // and emit a bool flag instead.
    it('development serves empty string', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-value-boolean-on', ctx({identifier: 'u1'}))).to.equal('')
    })

    it('production serves empty string', async () => {
      const q = await makeClient(datadir, 'production')
      expect(q.getString('fx-value-boolean-on', ctx({identifier: 'u1'}))).to.equal('')
    })
  })

  describe('fx-value-boolean-off — D-F1 boolean case: enabled=false → false', () => {
    it('development serves false', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-value-boolean-off', ctx({identifier: 'u1'}))).to.equal(false)
    })
  })

  describe('fx-value-string-with-disabled — D-F1 non-boolean case: serves stored value, not false', () => {
    it('development serves the stored string value, not a coerced false', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-value-string-with-disabled', ctx({identifier: 'u1'}))).to.equal('served-when-off')
    })
  })

  describe('fx-value-string-basic — STANDARD string, no rules', () => {
    it('serves the stored value', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-value-string-basic', ctx({identifier: 'u1'}))).to.equal('hello world')
    })
  })

  describe('fx-value-integer-positive — STANDARD int', () => {
    it('serves the stored numeric value', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getNumber('fx-value-integer-positive', ctx({identifier: 'u1'}))).to.equal(42)
    })
  })

  describe('fx-mv-string-3way — multivariate string, weighted_values rollout', () => {
    it('returns one of the declared variants for a stable key', async () => {
      const q = await makeClient(datadir, 'development')
      const value = q.getString('fx-mv-string-3way', ctx({identifier: 'stable-mv-key-1'}))
      expect(value).to.be.oneOf(['control', 'a', 'b'])
    })
  })

  describe('fx-segov-single — segment override swaps the served string value', () => {
    // fx-seg-single-condition is `plan == "enterprise"`. The converter emits
    // Flagsmith property names verbatim (no `kind.` prefix), so Quonfig
    // resolves them against contexts[""] — the unnamed context kind. The
    // live feature has `default_enabled=false` but the converter currently
    // keeps it as a string flag, so assertions exercise the string values.
    it('context in the segment (matching plan) gets the seg-value', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-segov-single', ctx({identifier: 'u1', traits: {plan: 'enterprise'}}))).to.equal(
        'seg-value',
      )
    })

    it('context NOT in the segment gets the default', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-segov-single', ctx({identifier: 'u2', traits: {plan: 'free'}}))).to.equal('default')
    })

    it('production has no segment override → still serves default', async () => {
      const q = await makeClient(datadir, 'production')
      expect(q.getString('fx-segov-single', ctx({identifier: 'u1', traits: {plan: 'enterprise'}}))).to.equal('default')
    })
  })

  describe('fx-segov-changes-value — segment override changes a string value', () => {
    // Same segment (fx-seg-single-condition: plan == "enterprise"); dev segov
    // value is "overridden", default is "default".
    it('matching context → override value', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-segov-changes-value', ctx({identifier: 'u1', traits: {plan: 'enterprise'}}))).to.equal(
        'overridden',
      )
    })

    it('non-matching context → default value', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-segov-changes-value', ctx({identifier: 'u2', traits: {plan: 'free'}}))).to.equal('default')
    })
  })

  describe('fx-idov-single — identity override pins the value for one identifier', () => {
    // Live idov: identifier="fx-id-string", value="id-override", default="default".
    it('matching identifier (user.key) gets the override', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-idov-single', ctx({identifier: 'fx-id-string'}))).to.equal('id-override')
    })

    it('other identifiers get the default', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getString('fx-idov-single', ctx({identifier: 'someone-else'}))).to.equal('default')
    })
  })

  describe('fx-idov-and-segov-conflict — D-F2: identity override wins over segment override', () => {
    // Live data: idov identifier="fx-id-string" → "identity-wins"; segov segment
    // is fx-seg-and-within-rule (plan=="enterprise" AND seats>10) → "segment-loses";
    // default is "default".
    it('identifier matching idov wins even when also in segment', async () => {
      const q = await makeClient(datadir, 'development')
      expect(
        q.getString(
          'fx-idov-and-segov-conflict',
          ctx({identifier: 'fx-id-string', traits: {plan: 'enterprise', seats: 11}}),
        ),
      ).to.equal('identity-wins')
    })

    it('identifier NOT in idov but matching the segment gets the segov value', async () => {
      const q = await makeClient(datadir, 'development')
      expect(
        q.getString(
          'fx-idov-and-segov-conflict',
          ctx({identifier: 'somebody-else', traits: {plan: 'enterprise', seats: 11}}),
        ),
      ).to.equal('segment-loses')
    })

    it('identifier in neither gets the default', async () => {
      const q = await makeClient(datadir, 'development')
      expect(
        q.getString('fx-idov-and-segov-conflict', ctx({identifier: 'nobody', traits: {plan: 'free', seats: 5}})),
      ).to.equal('default')
    })
  })

  describe('operator-family round-trips (segments evaluated directly via getBool)', () => {
    it('fx-op-equal — EQUAL on plan="enterprise" → true when matches, false otherwise', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-op-equal', ctx({identifier: 'u1', traits: {plan: 'enterprise'}}))).to.equal(true)
      expect(q.getBool('fx-op-equal', ctx({identifier: 'u2', traits: {plan: 'free'}}))).to.equal(false)
    })

    it('fx-op-greater-than — GREATER_THAN on age=18 → true when age>18', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-op-greater-than', ctx({identifier: 'u1', traits: {age: 21}}))).to.equal(true)
      expect(q.getBool('fx-op-greater-than', ctx({identifier: 'u2', traits: {age: 17}}))).to.equal(false)
    })

    it('fx-op-regex — REGEX on email matches ^admin@.*\\.com$', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-op-regex', ctx({identifier: 'u1', traits: {email: 'admin@example.com'}}))).to.equal(true)
      expect(q.getBool('fx-op-regex', ctx({identifier: 'u2', traits: {email: 'alice@elsewhere.org'}}))).to.equal(false)
    })

    it('fx-op-in — IN on comma-separated tenant_id list', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-op-in', ctx({identifier: 'u1', traits: {tenant_id: 'tenant_1'}}))).to.equal(true)
      expect(q.getBool('fx-op-in', ctx({identifier: 'u2', traits: {tenant_id: 'tenant_3'}}))).to.equal(true)
      expect(q.getBool('fx-op-in', ctx({identifier: 'u3', traits: {tenant_id: 'tenant_unknown'}}))).to.equal(false)
    })

    // IS_PRESENT / IS_NOT_PRESENT shipped in @quonfig/node 0.0.26; cli is now on
    // 0.0.28. Earlier this test only asserted the "missing trait" path because
    // the SDK didn't implement IS_PRESENT yet. Expanding to exercise the true
    // path is a follow-up bead — depends on knowing the exact identifier the
    // live fx-op-is-set segment-override pins to.
    it('fx-op-is-set — missing trait falls through to default', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-op-is-set', ctx({identifier: 'u2'}))).to.equal(false)
    })

    it('fx-op-semver-greater — :semver-stripped value compared as semver (version > 4.2.52)', async () => {
      const q = await makeClient(datadir, 'development')
      expect(q.getBool('fx-op-semver-greater', ctx({identifier: 'u1', traits: {version: '5.0.0'}}))).to.equal(true)
      expect(q.getBool('fx-op-semver-greater', ctx({identifier: 'u2', traits: {version: '4.0.0'}}))).to.equal(false)
    })
  })
})
