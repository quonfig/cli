import {type MigrationSource} from './source.js'
import {flagsmithSource} from './sources/flagsmith.js'
import {launchSource} from './sources/launch.js'
import {launchdarklySource} from './sources/launchdarkly.js'

const SOURCES: Record<string, MigrationSource> = {
  flagsmith: flagsmithSource,
  launch: launchSource,
  launchdarkly: launchdarklySource,
}

export class UnknownSourceError extends Error {
  constructor(name: string) {
    const supported = Object.keys(SOURCES).sort().join(', ')
    super(`Unknown migration source "${name}". Supported: ${supported}.`)
    this.name = 'UnknownSourceError'
  }
}

export function getSource(name: string): MigrationSource {
  const source = SOURCES[name]
  if (!source) {
    throw new UnknownSourceError(name)
  }

  return source
}

export function listSources(): string[] {
  return Object.keys(SOURCES).sort()
}
