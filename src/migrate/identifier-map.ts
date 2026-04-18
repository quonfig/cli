import fs from 'node:fs'
import path from 'node:path'

export type IdentifierMap = Record<string, string>

export interface CollisionPair {
  legacyKeyA: string
  legacyKeyB: string
  quonfigKeyA: string
  quonfigKeyB: string
}

export class IdentifierMapCollisionError extends Error {
  collisions: CollisionPair[]

  constructor(collisions: CollisionPair[]) {
    const lines = collisions.map(
      (c) =>
        `  - "${c.legacyKeyA}" → "${c.quonfigKeyA}" collides with "${c.legacyKeyB}" → "${c.quonfigKeyB}" (differ only in case)`,
    )
    super(
      `Identifier map has ${collisions.length} case-insensitive collision${
        collisions.length === 1 ? '' : 's'
      } — refusing to write .qf/identifier-map.json:\n${lines.join('\n')}`,
    )
    this.name = 'IdentifierMapCollisionError'
    this.collisions = collisions
  }
}

export function detectCollisions(mapping: IdentifierMap): CollisionPair[] {
  const legacyKeys = Object.keys(mapping).sort()
  const collisions: CollisionPair[] = []

  for (let i = 0; i < legacyKeys.length; i++) {
    const legacyA = legacyKeys[i]!
    const quonfigA = mapping[legacyA]!
    for (let j = i + 1; j < legacyKeys.length; j++) {
      const legacyB = legacyKeys[j]!
      const quonfigB = mapping[legacyB]!
      if (quonfigA !== quonfigB && quonfigA.toLowerCase() === quonfigB.toLowerCase()) {
        collisions.push({
          legacyKeyA: legacyA,
          legacyKeyB: legacyB,
          quonfigKeyA: quonfigA,
          quonfigKeyB: quonfigB,
        })
      }
    }
  }

  return collisions
}

function identifierMapPath(outputDir: string): string {
  return path.join(outputDir, '.qf', 'identifier-map.json')
}

export function writeIdentifierMap(outputDir: string, mapping: IdentifierMap): void {
  const collisions = detectCollisions(mapping)
  if (collisions.length > 0) {
    throw new IdentifierMapCollisionError(collisions)
  }

  const sorted: IdentifierMap = {}
  for (const key of Object.keys(mapping).sort()) {
    sorted[key] = mapping[key]!
  }

  const filePath = identifierMapPath(outputDir)
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}

export function readIdentifierMap(outputDir: string): IdentifierMap | null {
  const filePath = identifierMapPath(outputDir)
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw) as IdentifierMap
}
