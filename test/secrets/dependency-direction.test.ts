/**
 * src/verify is copied ALONE into the app-gitea image and compiled with bun
 * into the pre-receive hook (app-gitea/Dockerfile: `COPY verify/ verify/`,
 * then `bun build --compile verify/standalone.ts`), with only zod, ajv and
 * ajv-formats installed. So nothing under src/verify may import from outside
 * it: the qf1 library (src/secrets) imports from src/verify, never the
 * reverse (bead qfg-mol-hle).
 */
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const verifyDir = path.join(root, 'src', 'verify')
const libDir = path.join(root, 'src', 'secrets')
const INTERNAL_MODULE = path.join(libDir, 'qf1-internal.ts')

/** Packages the hook build installs (keep in step with app-gitea/Dockerfile). */
const HOOK_PACKAGES = new Set(['ajv', 'ajv-formats', 'zod'])

/** Every module specifier in a TS source: static imports/exports, dynamic import(), require(). */
function specifiers(source: string): string[] {
  const out: string[] = []
  const patterns = [
    /\b(?:import|export)\s[^"']*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1])
  return out
}

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((d) => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return tsFiles(p)
    return d.name.endsWith('.ts') ? [p] : []
  })
}

describe('dependency direction: src/verify imports nothing outside src/verify (qfg-mol-hle)', () => {
  const files = tsFiles(verifyDir)

  it('finds the verify sources, including secrets.ts', () => {
    expect(files.map((f) => path.basename(f))).to.include('secrets.ts')
  })

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    it(`${rel}`, () => {
      const bad: string[] = []
      for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:')) continue
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec)
          if (target !== verifyDir && !target.startsWith(verifyDir + path.sep)) bad.push(spec)
          continue
        }

        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!HOOK_PACKAGES.has(pkg)) bad.push(spec)
      }

      expect(bad, `${rel} imports from outside src/verify`).to.deep.equal([])
    })
  }

  it('within src/, only src/secrets/qf1.ts imports the internal qf1 module (seams and raw primitives)', () => {
    const importers = tsFiles(path.join(root, 'src'))
      .filter((f) => f !== INTERNAL_MODULE)
      .filter((f) => specifiers(fs.readFileSync(f, 'utf8')).some((s) => /(^|\/)qf1-internal(\.js)?$/.test(s)))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
    expect(importers).to.deep.equal(['src/secrets/qf1.ts'])
  })

  it('no code in src/secrets reads NODE_ENV', () => {
    for (const f of tsFiles(libDir)) {
      expect(fs.readFileSync(f, 'utf8'), path.basename(f)).not.to.match(/NODE_ENV/)
    }
  })

  it('the qf1 library imports the shared keyless pieces from src/verify', () => {
    const internal = fs.readFileSync(INTERNAL_MODULE, 'utf8')
    expect(specifiers(internal)).to.include('../verify/secrets.js')
  })
})
