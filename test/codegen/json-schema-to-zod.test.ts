import {expect} from 'chai'
import * as ts from 'typescript'
import {z} from 'zod'

import {jsonSchemaToZod} from '../../src/codegen/json-schema-to-zod.js'
import {ZodToStringMapper} from '../../src/codegen/language-mappers/zod-to-string-mapper.js'
import {ZodToTypescriptMapper} from '../../src/codegen/language-mappers/zod-to-typescript-mapper.js'
import * as introspect from '../../src/codegen/zod-introspection.js'
import {jevQuestionsSchema} from './fixtures/jev-questions-schema.js'

const toTs = (schema: z.ZodTypeAny) => new ZodToTypescriptMapper().resolveType(schema)

/** Type-checks `source` in memory and returns its diagnostics. */
const typeErrors = (source: string): string[] => {
  const fileName = 'generated.ts'
  const options: ts.CompilerOptions = {noEmit: true, strict: true, types: []}
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(fileName, source, languageVersion)
      : original.call(host, name, languageVersion, ...rest)
  const program = ts.createProgram([fileName], options, host)
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((d) => d.file?.fileName === fileName)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('jsonSchemaToZod', () => {
  it('converts object schemas with enums and literals', () => {
    const schema = jsonSchemaToZod({
      title: 'permissions',
      type: 'object',
      properties: {
        mode: {
          enum: ['warn', 'error'],
        },
        scope: {
          const: 'workspace',
        },
      },
      required: ['mode', 'scope'],
    })

    const rendered = new ZodToStringMapper().resolveType(schema)

    expect(rendered.split(' ').join('')).to.equal(
      "z.object({mode:z.enum(['warn','error']);scope:z.literal(\"workspace\")})",
    )
  })

  it('preserves metadata from title and description fields', () => {
    const schema = jsonSchemaToZod({
      title: 'Display title',
      description: 'Human readable description',
      type: 'string',
    })

    expect(introspect.getMetaDescription(schema)).to.equal('Human readable description')
  })

  describe('oneOf / anyOf', () => {
    const noul = {
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {type: {const: 'noul'}, instructions: {type: 'string'}},
    }
    const score = {
      type: 'object',
      required: ['type', 'criteria'],
      additionalProperties: false,
      properties: {type: {enum: ['score']}, criteria: {type: 'array', items: {type: 'string'}}},
    }

    it('emits a union for a oneOf that also declares type: object', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        oneOf: [
          {type: 'object', properties: {a: {type: 'string'}}, required: ['a']},
          {type: 'object', properties: {b: {type: 'number'}}, required: ['b']},
        ],
      })

      expect(introspect.isUnion(schema)).to.equal(true)
      expect(toTs(schema)).to.equal('{ "a": string } | { "b": number }')
    })

    it('emits a union for a oneOf with no type', () => {
      const schema = jsonSchemaToZod({oneOf: [{type: 'string'}, {type: 'number'}]})

      expect(toTs(schema)).to.equal('string | number')
    })

    it('emits a discriminatedUnion for a tagged oneOf', () => {
      const schema = jsonSchemaToZod({type: 'object', oneOf: [noul, score]})

      expect(schema).to.be.instanceOf(z.ZodDiscriminatedUnion)
      expect((schema as z.ZodDiscriminatedUnion).def.discriminator).to.equal('type')
      expect(toTs(schema)).to.equal(
        '{ "type": "noul"; "instructions"?: string } | { "type": \'score\'; "criteria": Array<string> }',
      )
      expect(schema.safeParse({type: 'score', criteria: ['a']}).success).to.equal(true)
      expect(schema.safeParse({type: 'nope'}).success).to.equal(false)
    })

    it('falls back to a plain union when the tag values are not distinct', () => {
      const schema = jsonSchemaToZod({
        oneOf: [noul, {...noul, properties: {...noul.properties, extra: {type: 'string'}}}],
      })

      expect(schema).to.not.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(introspect.isUnion(schema)).to.equal(true)
    })

    it('falls back to a plain union when a branch is not an object', () => {
      const schema = jsonSchemaToZod({oneOf: [noul, {type: 'string'}]})

      expect(schema).to.not.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(toTs(schema)).to.equal('{ "type": "noul"; "instructions"?: string } | string')
    })

    it('falls back to a plain union when more than one property could be the tag', () => {
      const a = {type: 'object', required: ['kind', 'v'], properties: {kind: {const: 'a'}, v: {const: 1}}}
      const b = {type: 'object', required: ['kind', 'v'], properties: {kind: {const: 'b'}, v: {const: 2}}}
      const schema = jsonSchemaToZod({oneOf: [a, b]})

      expect(schema).to.not.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(introspect.isUnion(schema)).to.equal(true)
    })

    it('emits T | null for a migrated nullable anyOf', () => {
      const schema = jsonSchemaToZod({anyOf: [{type: 'string'}, {type: 'null'}]})

      expect(toTs(schema)).to.equal('string | null')
    })

    it('keeps sibling properties next to a oneOf as an intersection', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        required: ['id'],
        properties: {id: {type: 'string'}},
        oneOf: [
          {type: 'object', properties: {a: {type: 'string'}}},
          {type: 'object', properties: {b: {type: 'number'}}},
        ],
      })

      expect(toTs(schema)).to.equal('{ "id": string } & ({ "a"?: string } | { "b"?: number })')
      expect(schema.safeParse({id: 'x', a: 'y'}).success).to.equal(true)
      expect(schema.safeParse({a: 'y'}).success).to.equal(false)
    })

    it('ignores a constraint-only anyOf (required) next to type: object', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {email: {type: 'string'}, phone: {type: 'string'}},
        anyOf: [{required: ['email']}, {required: ['phone']}],
      })

      expect(toTs(schema)).to.equal('{ "email"?: string; "phone"?: string }')
    })

    it('ignores a constraint-only anyOf (format) next to type: string', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {contact: {type: 'string', anyOf: [{format: 'email'}, {format: 'uri'}]}},
      })

      expect(toTs(schema)).to.equal('{ "contact"?: string }')
    })

    it('ignores a constraint-only oneOf (pattern, minLength) next to type: string', () => {
      const schema = jsonSchemaToZod({type: 'string', oneOf: [{pattern: '^a'}, {minLength: 3}]})

      expect(toTs(schema)).to.equal('string')
    })

    it('keeps the union when only some branches are constraint-only', () => {
      const schema = jsonSchemaToZod({anyOf: [{type: 'string'}, {minLength: 3}]})

      expect(introspect.isUnion(schema)).to.equal(true)
    })
  })

  describe('arrays with minItems', () => {
    it('emits a tuple with a rest element for minItems without maxItems', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 2, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('[string, string, ...string[]]')
      expect(schema.safeParse(['a', 'b', 'c']).success).to.equal(true)
      expect(schema.safeParse(['a']).success).to.equal(false)
    })

    it('keeps a plain array when maxItems is also set', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 2, maxItems: 4, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('Array<string>')
    })

    it('expands up to 8 fixed items', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 8, items: {type: 'string'}})

      expect(toTs(schema)).to.equal(`[${Array.from({length: 8}, () => 'string').join(', ')}, ...string[]]`)
    })

    it('keeps a plain array when minItems is above 8', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 9, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('Array<string>')
    })

    it('keeps a plain array for minItems: 0', () => {
      const schema = jsonSchemaToZod({type: 'array', minItems: 0, items: {type: 'string'}})

      expect(toTs(schema)).to.equal('Array<string>')
    })
  })

  describe('the Jev questions schema', () => {
    it('emits a record of a tagged union whose score rubric has a rest element', () => {
      const schema = jsonSchemaToZod(jevQuestionsSchema)
      const questions = (schema as z.ZodObject).shape.questions as z.ZodTypeAny

      expect(introspect.isRecord(questions)).to.equal(true)
      const {valueType} = introspect.getRecordTypes(questions as z.ZodRecord)
      expect(valueType).to.be.instanceOf(z.ZodDiscriminatedUnion)

      const rendered = toTs(schema)
      expect(rendered).to.contain('"type": "noul"')
      expect(rendered).to.contain('"type": "score"')
      expect(rendered).to.contain('"type": "choice"')
      expect(rendered).to.contain('"criteria": [string, string, ...string[]] }')
      expect(rendered).to.contain('"criteria": Record<string, string> }')
      expect(rendered).to.match(
        /"criteria"\?: { (\/\*\* [^*]+ \*\/ )?"true"\?: string; (\/\*\* [^*]+ \*\/ )?"false"\?: string }/,
      )
    })
  })

  describe('$ref / $defs (qfg-o5rp)', () => {
    const address = {
      type: 'object',
      required: ['street'],
      properties: {street: {type: 'string'}, zip: {type: 'string'}},
    }

    it('resolves a local #/$defs ref', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        required: ['home'],
        properties: {home: {$ref: '#/$defs/address'}, work: {$ref: '#/$defs/address'}},
        $defs: {address},
      })

      expect(toTs(schema)).to.equal(
        '{ "home": { "street": string; "zip"?: string }; "work"?: { "street": string; "zip"?: string } }',
      )
    })

    it('resolves a draft-07 #/definitions ref, in array items too', () => {
      const schema = jsonSchemaToZod({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        items: {$ref: '#/definitions/address'},
        definitions: {address},
      })

      expect(toTs(schema)).to.equal('Array<{ "street": string; "zip"?: string }>')
    })

    it('follows a ref to a ref, and decodes ~0 / ~1 / percent escapes in the pointer', () => {
      const schema = jsonSchemaToZod({
        $ref: '#/$defs/alias',
        $defs: {alias: {$ref: '#/$defs/a~1b~0c%20d'}, 'a/b~c d': {type: 'integer'}},
      })

      expect(toTs(schema)).to.equal('number')
    })

    it('keeps the referencing schema title/description as the field comment', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {home: {$ref: '#/$defs/address', description: 'Where they live'}},
        $defs: {address: {...address, description: 'A postal address'}},
      })

      const home = (schema as z.ZodObject).shape.home as z.ZodTypeAny
      expect(introspect.getMetaDescription((home as z.ZodOptional<z.ZodTypeAny>).unwrap())).to.equal('Where they live')
    })

    it('sees through $ref branches to build a discriminatedUnion', () => {
      const schema = jsonSchemaToZod({
        oneOf: [{$ref: '#/$defs/cat'}, {$ref: '#/$defs/dog'}],
        $defs: {
          cat: {type: 'object', required: ['kind'], properties: {kind: {const: 'cat'}, lives: {type: 'integer'}}},
          dog: {type: 'object', required: ['kind'], properties: {kind: {const: 'dog'}, good: {type: 'boolean'}}},
        },
      })

      expect(schema).to.be.instanceOf(z.ZodDiscriminatedUnion)
      expect(toTs(schema)).to.equal('{ "kind": "cat"; "lives"?: number } | { "kind": "dog"; "good"?: boolean }')
    })

    it('types a self-referencing $defs entry as unknown at the point it recurses, with a comment', () => {
      const schema = jsonSchemaToZod({
        $ref: '#/$defs/node',
        $defs: {
          node: {
            type: 'object',
            required: ['value'],
            properties: {value: {type: 'number'}, children: {type: 'array', items: {$ref: '#/$defs/node'}}},
          },
        },
      })

      expect(toTs(schema)).to.equal('{ "value": number; "children"?: Array<unknown> }')
      const children = (schema as z.ZodObject).shape.children as z.ZodTypeAny
      const item = ((children as z.ZodOptional<z.ZodTypeAny>).unwrap() as z.ZodArray).element as z.ZodTypeAny
      expect(introspect.isUnknown(item)).to.equal(true)
      expect(introspect.getMetaDescription(item)).to.contain('#/$defs/node')
    })

    it('types a ref back to the root (#) as unknown', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {name: {type: 'string'}, parent: {$ref: '#'}},
      })

      expect(toTs(schema)).to.equal(
        '{ "name"?: string; /** Recursive $ref #, typed unknown at this depth. */ "parent"?: unknown }',
      )
    })

    it('handles mutual recursion between two $defs', () => {
      const schema = jsonSchemaToZod({
        $ref: '#/$defs/a',
        $defs: {
          a: {type: 'object', properties: {b: {$ref: '#/$defs/b'}}},
          b: {type: 'object', properties: {a: {$ref: '#/$defs/a'}}},
        },
      })

      expect(toTs(schema)).to.equal(
        '{ "b"?: { /** Recursive $ref #/$defs/a, typed unknown at this depth. */ "a"?: unknown } }',
      )
    })

    it('does not fetch a remote $ref: it is typed unknown with a comment naming it', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {geo: {$ref: 'https://example.com/schemas/geo.json'}},
      })

      expect(toTs(schema)).to.match(
        /^{ \/\*\* [^*]*https:\/\/example\.com\/schemas\/geo\.json[^*]* \*\/ "geo"\?: unknown }$/,
      )
    })

    it('cannot close the generated comment early with a ref containing */', () => {
      const schema = jsonSchemaToZod({type: 'object', properties: {x: {$ref: 'https://e.com/a*/b'}}})

      expect(toTs(schema)).to.contain('a*\\/b')
      expect(typeErrors(`type T = ${toTs(schema)}\nexport const v: T = {}\n`)).to.deep.equal([])
    })

    it('types a local $ref whose target is missing as unknown with a comment', () => {
      const schema = jsonSchemaToZod({type: 'object', properties: {x: {$ref: '#/$defs/missing'}}})

      const x = ((schema as z.ZodObject).shape.x as z.ZodOptional<z.ZodTypeAny>).unwrap()
      expect(introspect.isUnknown(x)).to.equal(true)
      expect(introspect.getMetaDescription(x)).to.contain('#/$defs/missing')
    })

    it('generates TypeScript that compiles for refs, recursion and remote refs', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        required: ['home', 'tree'],
        properties: {
          home: {$ref: '#/$defs/address'},
          tree: {$ref: '#/$defs/node'},
          geo: {$ref: 'https://example.com/geo.json'},
        },
        $defs: {
          address,
          node: {type: 'object', properties: {children: {type: 'array', items: {$ref: '#/$defs/node'}}}},
        },
      })

      const source = `type Generated = ${toTs(schema)}
const value: Generated = {home: {street: 'Main'}, tree: {children: [{children: []}]}, geo: 1}
export {value}
`
      expect(typeErrors(source)).to.deep.equal([])
      // Not vacuous: the resolved ref really requires street.
      expect(typeErrors(source.replace("{street: 'Main'}", '{}'))).to.have.length.greaterThan(0)
    })
  })
})
