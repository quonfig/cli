/**
 * JSON Schema validation for schema-bound config values (qfg-phcv).
 *
 * Mirrors app-quonfig src/lib/domain/schema-validator.ts so `qfg verify` and
 * the app give the same verdict on the same value. Rules (decided in
 * project/plans/2026-09-25-advanced-schema-for-jev.md W1/W6):
 * - Draft 2020-12 by default. A `$schema` naming draft-07 (http or https,
 *   with or without `#`) uses a separate draft-07 Ajv instance, because
 *   draft-07 tuple `items: [...]` does not compile on Ajv2020. Draft-06 and
 *   older are a compile error.
 * - A schema that does not compile is an error, never a skipped validation.
 * - `format` is enforced through ajv-formats. The app's long-text editor
 *   hints (`textarea`, `multiline`, `multi-line`) are always-valid formats.
 * - `addUsedSchema: false`: two schemas declaring the same `$id` must not
 *   collide in the shared Ajv instance.
 *
 * Lives inside cli/src/verify/ because the app-gitea hook build only copies
 * this directory (see validate.ts). The hook runs value validation
 * (qfg-q5f6.10), so app-gitea/Dockerfile must install `ajv` and
 * `ajv-formats`.
 *
 * Imports: the CLI is ESM with nodenext resolution and Ajv ships CommonJS, so
 * the default import may be the class or the module object depending on the
 * runtime (node vs bun). `ajv/dist/2020.js` is imported by explicit path; a
 * bare `ajv` must resolve to the direct v8 dependency, not the v6 eslint
 * hoists.
 */
import AjvDraft07Import from 'ajv'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'

import {type SchemaViolation, schemaErrorsToViolations} from './schema-error-reshape.js'

export type {SchemaViolation} from './schema-error-reshape.js'

/** Formats the app treats as editor hints; they accept any string. */
export const ALWAYS_VALID_FORMATS = ['textarea', 'multiline', 'multi-line']

const DRAFT_07_SCHEMA_URL = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/
const DRAFT_07_CANONICAL_URL = 'http://json-schema.org/draft-07/schema#'
const PRE_DRAFT_07_SCHEMA_URL = /^https?:\/\/json-schema\.org\/(draft-0[0-6]\/)?schema#?$/

const AJV_OPTIONS = {
  addUsedSchema: false,
  allErrors: true,
  strict: false,
} as const

type ValidateFn = ((value: unknown) => boolean) & {errors?: null | unknown[]}
interface AjvLike {
  addFormat(name: string, format: boolean): unknown
  compile(schema: object): ValidateFn
}
type AjvCtor = new (options: typeof AJV_OPTIONS) => AjvLike

function interop<T>(imported: unknown): T {
  const mod = imported as {default?: unknown}
  return (typeof mod === 'function' ? mod : (mod.default ?? mod)) as T
}

const AjvDraft07 = interop<AjvCtor>(AjvDraft07Import)
const Ajv2020 = interop<AjvCtor>(Ajv2020Import)
const addFormats = interop<(ajv: AjvLike) => unknown>(addFormatsImport)

function configure(ajv: AjvLike): AjvLike {
  addFormats(ajv)
  for (const format of ALWAYS_VALID_FORMATS) ajv.addFormat(format, true)
  return ajv
}

let ajv2020: AjvLike | undefined
let ajvDraft07: AjvLike | undefined

function getAjv2020(): AjvLike {
  ajv2020 ??= configure(new Ajv2020(AJV_OPTIONS))
  return ajv2020
}

function getAjvDraft07(): AjvLike {
  ajvDraft07 ??= configure(new AjvDraft07(AJV_OPTIONS))
  return ajvDraft07
}

export type CompiledSchema = {ok: false; reason: string} | {ok: true; validate: ValidateFn}

const compiledByObject = new WeakMap<object, CompiledSchema>()

function compileUncached(schema: Record<string, unknown>): CompiledSchema {
  const declared = schema.$schema
  let ajv = getAjv2020()
  let toCompile = schema
  if (typeof declared === 'string') {
    if (DRAFT_07_SCHEMA_URL.test(declared)) {
      ajv = getAjvDraft07()
      // Ajv only knows the draft-07 meta-schema by its canonical id; the
      // https and no-`#` spellings name the same draft.
      toCompile = {...schema, $schema: DRAFT_07_CANONICAL_URL}
    } else if (PRE_DRAFT_07_SCHEMA_URL.test(declared)) {
      return {ok: false, reason: `unsupported $schema ${declared}; use draft 2020-12 or draft-07`}
    }
  }

  try {
    return {ok: true, validate: ajv.compile(toCompile)}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Ajv's meta-schema failure already starts with "schema is invalid: ".
    return {ok: false, reason: message.replace(/^schema is invalid: /, '')}
  }
}

/** Compile (cached per schema object) a validator. Never throws. */
export function compileSchema(schema: Record<string, unknown>): CompiledSchema {
  let compiled = compiledByObject.get(schema)
  if (!compiled) {
    compiled = compileUncached(schema)
    compiledByObject.set(schema, compiled)
  }

  return compiled
}

export type SchemaValidationResult =
  | {kind: 'invalid-schema'; ok: false; reason: string}
  | {kind: 'violations'; ok: false; violations: SchemaViolation[]}
  | {ok: true}

/** Validate `value` against `schema`. Never throws. */
export function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaValidationResult {
  const compiled = compileSchema(schema)
  if (!compiled.ok) return {kind: 'invalid-schema', ok: false, reason: compiled.reason}
  if (compiled.validate(value)) return {ok: true}
  const errors = (compiled.validate.errors ?? []) as Parameters<typeof schemaErrorsToViolations>[0]
  return {kind: 'violations', ok: false, violations: schemaErrorsToViolations(errors, schema, value)}
}
