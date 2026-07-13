import camelCase from 'lodash.camelcase'
import {z} from 'zod'

import {ZodToTypescriptMapper} from '../language-mappers/zod-to-typescript-mapper.js'
import {SchemaExtractor} from '../schema-extractor.js'
import {BaseGenerator, BaseGeneratorArgs} from './base-generator.js'

/** One group of keys whose camelCased accessor identifiers collided (qfg-hbuy.8). */
export interface AccessorNameCollisionGroup {
  /** Final `key -> methodName` assignments, in lexicographic key order. */
  assignments: Array<{key: string; methodName: string}>
  /** The shared base identifier the keys collided on (e.g. `myFlag`). */
  identifier: string
}

export abstract class BaseTypescriptGenerator extends BaseGenerator {
  protected MUSTACHE_IMPORT = "import Mustache from 'mustache'"
  private schemaExtractor: SchemaExtractor

  constructor({configFile, log, warn}: BaseGeneratorArgs) {
    super({configFile, log, warn})
    this.schemaExtractor = new SchemaExtractor(log)
  }

  /**
   * Maps each config key to a unique, deterministic accessor method name
   * (qfg-hbuy.8). Separator-distinct keys (`my-flag` / `my_flag` / `my.flag`)
   * legally coexist under Policy A but all camelCase to the same identifier;
   * the generators used to throw on the collision and write NOTHING. Instead:
   *
   *  - non-colliding keys keep their plain camelCased identifier (so a
   *    workspace without collisions produces byte-identical output to before),
   *  - within a colliding group, keys sort lexicographically (by source key);
   *    the first keeps the base identifier, the rest get numeric suffixes
   *    (`myFlag2`, `myFlag3`, ...), skipping any identifier already claimed by
   *    another key (including a literal `myFlag2` key, or another group's
   *    base/suffix).
   *
   * Deterministic: same key set in any order -> same assignment.
   */
  protected assignAccessorMethodNames(keys: string[]): {
    collisions: AccessorNameCollisionGroup[]
    methodNameByKey: Map<string, string>
  } {
    const groups = new Map<string, string[]>()
    for (const key of keys) {
      const base = this.accessorMethodBaseName(key)
      const members = groups.get(base)
      if (members) {
        members.push(key)
      } else {
        groups.set(base, [key])
      }
    }

    // Every base identifier is claimed up front — by its singleton owner or by
    // the lexicographically-first member of its colliding group — so suffix
    // candidates can never steal one.
    const claimed = new Set(groups.keys())
    const methodNameByKey = new Map<string, string>()
    const collisions: AccessorNameCollisionGroup[] = []

    // Process groups in sorted-base order so cross-group suffix claims (e.g. a
    // large `myFlag` group reaching `myFlag22` vs a `myFlag2` group's suffixes)
    // resolve identically on every run.
    for (const base of [...groups.keys()].sort()) {
      const members = groups.get(base)!
      if (members.length === 1) {
        methodNameByKey.set(members[0], base)
        continue
      }

      const sorted = [...members].sort()
      const assignments: AccessorNameCollisionGroup['assignments'] = [{key: sorted[0], methodName: base}]
      methodNameByKey.set(sorted[0], base)

      let n = 2
      for (const key of sorted.slice(1)) {
        while (claimed.has(`${base}${n}`)) n++
        const methodName = `${base}${n}`
        claimed.add(methodName)
        methodNameByKey.set(key, methodName)
        assignments.push({key, methodName})
        n++
      }

      collisions.push({assignments, identifier: base})
    }

    return {collisions, methodNameByKey}
  }

  protected configurations() {
    return this.configFile.configs
      .filter((config) => config.configType === 'FEATURE_FLAG' || config.configType === 'CONFIG')
      .filter((config) => config.rows.length > 0)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((config) => {
        const schema = this.schemaExtractor.execute({
          config,
          configFile: this.configFile,
          durationTypeMap: this.durationTypeMap,
        })

        return {
          configType: config.configType,
          hasFunction: schema && new ZodToTypescriptMapper().resolveType(schema).includes('=>'),
          key: config.key,
          schema,
          sendToClientSdk: config.sendToClientSdk ?? false,
        }
      })
  }

  protected durationTypeMap(): z.ZodTypeAny {
    return z.number()
  }

  /** One always-visible warning per colliding identifier group (qfg-hbuy.8). */
  protected warnOnAccessorNameCollisions(collisions: AccessorNameCollisionGroup[]): void {
    for (const group of collisions) {
      const mapping = group.assignments.map((a) => `"${a.key}" -> ${a.methodName}()`).join(', ')
      this.warn(
        `${group.assignments.length} keys camelCase to the same accessor identifier '${group.identifier}'; ` +
          `assigned deterministic numeric suffixes: ${mapping}. ` +
          `String lookups (get('<key>')) are unaffected. Rename the keys to remove the suffixes.`,
      )
    }
  }

  private accessorMethodBaseName(key: string): string {
    const methodName = camelCase(key)
    // If the method name starts with a digit, prefix it with an underscore to
    // ensure the method name is valid.
    return /^\d/.test(methodName) ? `_${methodName}` : methodName
  }

  abstract declarationGenerate(): string
  abstract generate(): string
}
