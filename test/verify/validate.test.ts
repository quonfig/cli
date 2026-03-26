import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {validateFileMap, validateWorkspace} from '../../src/verify/validate.js'

function createWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-'))

  fs.mkdirSync(path.join(dir, 'configs'), {recursive: true})
  fs.mkdirSync(path.join(dir, 'schemas'), {recursive: true})
  fs.mkdirSync(path.join(dir, 'schemas-protected'), {recursive: true})

  fs.writeFileSync(
    path.join(dir, 'configs', 'feature.json'),
    JSON.stringify(
      {
        key: 'feature',
        type: 'config',
        valueType: 'json',
        schemaKey: 'permissions',
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'json', value: {}},
            },
          ],
        },
        environments: [],
        variants: [],
      },
      null,
      2,
    ),
  )

  fs.writeFileSync(
    path.join(dir, 'schemas', 'permissions.json'),
    JSON.stringify(
      {
        title: 'permissions',
        type: 'object',
        properties: {
          name: {type: 'string'},
        },
        required: ['name'],
      },
      null,
      2,
    ),
  )

  fs.writeFileSync(
    path.join(dir, 'schemas-protected', 'secret.json'),
    JSON.stringify(
      {
        title: 'secret',
        type: 'object',
        properties: {
          token: {type: 'string'},
        },
        required: ['token'],
      },
      null,
      2,
    ),
  )

  return dir
}

describe('validate', () => {
  it('accepts first-class schema files in both schema directories', () => {
    const workspace = createWorkspace()

    try {
      const result = validateWorkspace(workspace)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    } finally {
      fs.rmSync(workspace, {recursive: true, force: true})
    }
  })

  it('accepts schema files from git-hook file maps', () => {
    const files = new Map<string, string>([
      [
        'configs/feature.json',
        JSON.stringify(
          {
            key: 'feature',
            type: 'config',
            valueType: 'json',
            schemaKey: 'permissions',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'json', value: {}},
                },
              ],
            },
            environments: [],
            variants: [],
          },
          null,
          2,
        ),
      ],
      [
        'schemas/permissions.json',
        JSON.stringify(
          {
            title: 'permissions',
            type: 'object',
            properties: {
              name: {type: 'string'},
            },
            required: ['name'],
          },
          null,
          2,
        ),
      ],
      [
        'schemas-protected/secret.json',
        JSON.stringify(
          {
            title: 'secret',
            type: 'object',
            properties: {
              token: {type: 'string'},
            },
            required: ['token'],
          },
          null,
          2,
        ),
      ],
    ])

    const result = validateFileMap(files)

    expect(result.valid).to.be.true
    expect(result.issues).to.be.empty
  })
})
