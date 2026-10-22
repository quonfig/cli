import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Shared regex v1 fixtures for the cli writer tests (qfg-ktkr.2).

export function flag(key: string, criterion: Record<string, unknown>): string {
  return JSON.stringify({
    key,
    type: 'feature_flag',
    valueType: 'bool',
    default: {
      rules: [
        {criteria: [criterion], value: {type: 'bool', value: true}},
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
      ],
    },
    environments: [],
    variants: [],
  })
}

export function segment(key: string, criterion: Record<string, unknown>): string {
  return JSON.stringify({
    key,
    type: 'segment',
    valueType: 'bool',
    default: {
      rules: [
        {criteria: [criterion], value: {type: 'bool', value: true}},
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
      ],
    },
    environments: [],
    variants: [],
  })
}

export const regex = (operator: string, value: unknown, type = 'string') => ({
  operator,
  propertyName: 'user.email',
  valueToMatch: {type, value},
})

/** The planted workspace: a ReDoS-shaped flag pattern and a \d segment pattern. */
export function plantedFiles(): Map<string, string> {
  return new Map([
    ['feature-flags/planted-redos.json', flag('planted-redos', regex('PROP_MATCHES', '(a+)+$'))],
    ['quonfig.json', JSON.stringify({environments: ['production']})],
    ['segments/planted-digit.json', segment('planted-digit', regex('PROP_DOES_NOT_MATCH', '^\\d{3}$'))],
  ])
}

/** The same workspace with in-subset patterns. */
export function cleanFiles(): Map<string, string> {
  return new Map([
    ['feature-flags/planted-redos.json', flag('planted-redos', regex('PROP_MATCHES', '^[0-9]{3}$'))],
    ['quonfig.json', JSON.stringify({environments: ['production']})],
    ['segments/planted-digit.json', segment('planted-digit', regex('PROP_DOES_NOT_MATCH', '^[0-9]{3}$'))],
  ])
}

export function writeWorkspace(files: Map<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-regex-v1-'))
  for (const [rel, content] of files) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
    fs.writeFileSync(path.join(dir, rel), content)
  }

  return dir
}
