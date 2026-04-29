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

  fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({environments: []}, null, 2))

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

  describe('variant validation', () => {
    it('passes when rule values match defined variants', () => {
      const files = new Map<string, string>([
        [
          'feature-flags/my-flag.json',
          JSON.stringify({
            key: 'my-flag',
            type: 'feature_flag',
            valueType: 'bool',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'bool', value: false},
                },
              ],
            },
            environments: [],
            variants: [
              {name: 'On', value: {type: 'bool', value: true}},
              {name: 'Off', value: {type: 'bool', value: false}},
            ],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    })

    it('errors when a rule value does not match any variant', () => {
      const files = new Map<string, string>([
        [
          'configs/my-config.json',
          JSON.stringify({
            key: 'my-config',
            type: 'config',
            valueType: 'string',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'string', value: 'invalid-value'},
                },
              ],
            },
            environments: [],
            variants: [
              {name: 'A', value: {type: 'string', value: 'alpha'}},
              {name: 'B', value: {type: 'string', value: 'beta'}},
            ],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.false
      const variantIssues = result.issues.filter((i) => i.message.includes('does not match any defined variant'))
      expect(variantIssues).to.have.length(1)
      expect(variantIssues[0].severity).to.equal('error')
      expect(variantIssues[0].message).to.include('default.rules[0]')
    })

    it('errors when an environment rule value does not match any variant', () => {
      const files = new Map<string, string>([
        [
          'feature-flags/my-flag.json',
          JSON.stringify({
            key: 'my-flag',
            type: 'feature_flag',
            valueType: 'bool',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'bool', value: true},
                },
              ],
            },
            environments: [
              {
                id: 'production',
                rules: [
                  {
                    criteria: [{operator: 'ALWAYS_TRUE'}],
                    value: {type: 'bool', value: false},
                  },
                ],
              },
            ],
            variants: [{name: 'On', value: {type: 'bool', value: true}}],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.false
      const variantIssues = result.issues.filter((i) => i.message.includes('does not match any defined variant'))
      expect(variantIssues).to.have.length(1)
      expect(variantIssues[0].message).to.include('environments[production].rules[0]')
    })

    it('passes when weighted values all match defined variants', () => {
      const files = new Map<string, string>([
        [
          'feature-flags/rollout.json',
          JSON.stringify({
            key: 'rollout',
            type: 'feature_flag',
            valueType: 'bool',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {
                    type: 'weighted_values',
                    value: {
                      weightedValues: [
                        {value: {type: 'bool', value: true}, weight: 50_000},
                        {value: {type: 'bool', value: false}, weight: 50_000},
                      ],
                      hashByPropertyName: 'user.key',
                    },
                  },
                },
              ],
            },
            environments: [],
            variants: [
              {name: 'On', value: {type: 'bool', value: true}},
              {name: 'Off', value: {type: 'bool', value: false}},
            ],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    })

    it('errors when a weighted value does not match any variant', () => {
      const files = new Map<string, string>([
        [
          'configs/color.json',
          JSON.stringify({
            key: 'color',
            type: 'config',
            valueType: 'string',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {
                    type: 'weighted_values',
                    value: {
                      weightedValues: [
                        {value: {type: 'string', value: 'red'}, weight: 50_000},
                        {value: {type: 'string', value: 'purple'}, weight: 50_000},
                      ],
                      hashByPropertyName: 'user.key',
                    },
                  },
                },
              ],
            },
            environments: [],
            variants: [
              {name: 'Red', value: {type: 'string', value: 'red'}},
              {name: 'Blue', value: {type: 'string', value: 'blue'}},
            ],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.false
      const variantIssues = result.issues.filter((i) => i.message.includes('does not match any defined variant'))
      expect(variantIssues).to.have.length(1)
      expect(variantIssues[0].message).to.include('weightedValues[1]')
    })

    it('skips variant check when variants array is empty', () => {
      const files = new Map<string, string>([
        [
          'configs/timeout.json',
          JSON.stringify({
            key: 'timeout',
            type: 'config',
            valueType: 'int',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'int', value: 30},
                },
              ],
            },
            environments: [],
            variants: [],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    })

    it('errors when a weighted_values rollout has no variants defined', () => {
      const files = new Map<string, string>([
        [
          'configs/color.json',
          JSON.stringify({
            key: 'color',
            type: 'config',
            valueType: 'string',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'string', value: 'red'},
                },
              ],
            },
            environments: [
              {
                id: 'production',
                rules: [
                  {
                    criteria: [],
                    value: {
                      type: 'weighted_values',
                      value: {
                        weightedValues: [
                          {value: {type: 'string', value: 'red'}, weight: 50_000},
                          {value: {type: 'string', value: 'blue'}, weight: 50_000},
                        ],
                        hashByPropertyName: 'user.key',
                      },
                    },
                  },
                ],
              },
            ],
            variants: [],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.false
      const missingVariantIssues = result.issues.filter((i) =>
        i.message.includes('weighted_values rollout requires at least one variant'),
      )
      expect(missingVariantIssues).to.have.length(1)
      expect(missingVariantIssues[0].message).to.include('environments[production].rules[0]')
    })

    it('skips variant check for provided value types', () => {
      const files = new Map<string, string>([
        [
          'configs/provided-config.json',
          JSON.stringify({
            key: 'provided-config',
            type: 'config',
            valueType: 'string',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'provided', value: {source: 'context', lookup: 'user.email'}},
                },
              ],
            },
            environments: [],
            variants: [{name: 'A', value: {type: 'string', value: 'alpha'}}],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    })

    it('validates variant matching with validateWorkspace', () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-variant-'))

      try {
        fs.mkdirSync(path.join(workspace, 'feature-flags'), {recursive: true})
        fs.writeFileSync(path.join(workspace, 'quonfig.json'), JSON.stringify({environments: []}, null, 2))
        fs.writeFileSync(
          path.join(workspace, 'feature-flags', 'bad-flag.json'),
          JSON.stringify({
            key: 'bad-flag',
            type: 'feature_flag',
            valueType: 'string',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'string', value: 'invalid'},
                },
              ],
            },
            environments: [],
            variants: [
              {name: 'A', value: {type: 'string', value: 'alpha'}},
              {name: 'B', value: {type: 'string', value: 'beta'}},
            ],
          }),
        )

        const result = validateWorkspace(workspace)

        expect(result.valid).to.be.false
        const variantIssues = result.issues.filter((i) => i.message.includes('does not match any defined variant'))
        expect(variantIssues).to.have.length(1)
      } finally {
        fs.rmSync(workspace, {recursive: true, force: true})
      }
    })
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

  describe('feature_flag sendToClientSdk rejection', () => {
    it('errors when a feature_flag has sendToClientSdk=true', () => {
      const files = new Map<string, string>([
        [
          'feature-flags/client-flag.json',
          JSON.stringify({
            key: 'client-flag',
            type: 'feature_flag',
            valueType: 'bool',
            sendToClientSdk: true,
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'bool', value: true},
                },
              ],
            },
            environments: [],
            variants: [{name: 'On', value: {type: 'bool', value: true}}],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.false
      const stcIssues = result.issues.filter(
        (i) => i.file === 'feature-flags/client-flag.json' && i.message.includes('sendToClientSdk'),
      )
      expect(stcIssues).to.have.length(1)
      expect(stcIssues[0].severity).to.equal('error')
      expect(stcIssues[0].message).to.include('feature_flag')
    })

    it('errors when a feature_flag has sendToClientSdk=false (key is forbidden regardless of value)', () => {
      const files = new Map<string, string>([
        [
          'feature-flags/also-bad.json',
          JSON.stringify({
            key: 'also-bad',
            type: 'feature_flag',
            valueType: 'bool',
            sendToClientSdk: false,
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'bool', value: true},
                },
              ],
            },
            environments: [],
            variants: [{name: 'On', value: {type: 'bool', value: true}}],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.false
      const stcIssues = result.issues.filter((i) => i.message.includes('sendToClientSdk'))
      expect(stcIssues).to.have.length(1)
      expect(stcIssues[0].severity).to.equal('error')
    })

    it('accepts a feature_flag without the sendToClientSdk key', () => {
      const files = new Map<string, string>([
        [
          'feature-flags/ok-flag.json',
          JSON.stringify({
            key: 'ok-flag',
            type: 'feature_flag',
            valueType: 'bool',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'bool', value: true},
                },
              ],
            },
            environments: [],
            variants: [{name: 'On', value: {type: 'bool', value: true}}],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    })

    it('still allows sendToClientSdk on config rows', () => {
      const files = new Map<string, string>([
        [
          'configs/my-config.json',
          JSON.stringify({
            key: 'my-config',
            type: 'config',
            valueType: 'string',
            sendToClientSdk: true,
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'string', value: 'alpha'},
                },
              ],
            },
            environments: [],
            variants: [{name: 'A', value: {type: 'string', value: 'alpha'}}],
          }),
        ],
      ])

      const result = validateFileMap(files)

      expect(result.valid).to.be.true
      expect(result.issues).to.be.empty
    })

    it('rejects a feature_flag fixture file via validateWorkspace', () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-stc-'))
      try {
        fs.mkdirSync(path.join(workspace, 'feature-flags'), {recursive: true})
        fs.writeFileSync(path.join(workspace, 'quonfig.json'), JSON.stringify({environments: []}, null, 2))
        fs.writeFileSync(
          path.join(workspace, 'feature-flags', 'bad-client-flag.json'),
          JSON.stringify({
            key: 'bad-client-flag',
            type: 'feature_flag',
            valueType: 'bool',
            sendToClientSdk: true,
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'bool', value: true},
                },
              ],
            },
            environments: [],
            variants: [{name: 'On', value: {type: 'bool', value: true}}],
          }),
        )

        const result = validateWorkspace(workspace)

        expect(result.valid).to.be.false
        const stcIssues = result.issues.filter((i) => i.message.includes('sendToClientSdk'))
        expect(stcIssues).to.have.length(1)
        expect(stcIssues[0].file).to.equal('feature-flags/bad-client-flag.json')
      } finally {
        fs.rmSync(workspace, {recursive: true, force: true})
      }
    })
  })

  describe('access enum validation (qfg-azk.1)', () => {
    function configWithAccess(access: unknown): Map<string, string> {
      const config: Record<string, unknown> = {
        key: 'my-config',
        type: 'config',
        valueType: 'string',
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'string', value: 'alpha'},
            },
          ],
        },
        environments: [],
        variants: [],
      }
      if (access !== undefined) config.access = access
      return new Map<string, string>([['configs/my-config.json', JSON.stringify(config)]])
    }

    it('rejects access with an unknown enum value', () => {
      const result = validateFileMap(configWithAccess('banana'))

      expect(result.valid).to.be.false
      const accessIssues = result.issues.filter((i) => i.message.includes('access'))
      expect(accessIssues, JSON.stringify(result.issues)).to.have.length.greaterThan(0)
      expect(accessIssues[0].severity).to.equal('error')
    })

    for (const value of ['support', 'standard', 'protected-env', 'protected-all-envs']) {
      it(`accepts access="${value}"`, () => {
        const result = validateFileMap(configWithAccess(value))
        expect(result.valid, JSON.stringify(result.issues)).to.be.true
        expect(result.issues).to.be.empty
      })
    }

    it('accepts a config with no access field (defaults apply)', () => {
      const result = validateFileMap(configWithAccess(undefined))
      expect(result.valid, JSON.stringify(result.issues)).to.be.true
      expect(result.issues).to.be.empty
    })

    it('parses a fixture config with access="standard" via validateWorkspace (rename works)', () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-access-'))
      try {
        fs.mkdirSync(path.join(workspace, 'configs'), {recursive: true})
        fs.writeFileSync(path.join(workspace, 'quonfig.json'), JSON.stringify({environments: []}, null, 2))
        fs.writeFileSync(
          path.join(workspace, 'configs', 'my-config.json'),
          JSON.stringify({
            key: 'my-config',
            type: 'config',
            valueType: 'string',
            access: 'standard',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {type: 'string', value: 'alpha'},
                },
              ],
            },
            environments: [],
            variants: [],
          }),
        )

        const result = validateWorkspace(workspace)
        expect(result.valid, JSON.stringify(result.issues)).to.be.true
        expect(result.issues).to.be.empty
      } finally {
        fs.rmSync(workspace, {recursive: true, force: true})
      }
    })
  })

  describe('segment access tier validation (qfg-0wo)', () => {
    function segmentWithAccess(access: string): Map<string, string> {
      const segment: Record<string, unknown> = {
        key: 'beta-users',
        type: 'segment',
        valueType: 'bool',
        sendToClientSdk: false,
        access,
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'bool', value: false},
            },
          ],
        },
        environments: [],
        variants: [],
      }
      return new Map<string, string>([['segments/beta-users.json', JSON.stringify(segment)]])
    }

    it('rejects access="protected-env" on a segment (cross-env, no per-env protection)', () => {
      const result = validateFileMap(segmentWithAccess('protected-env'))

      expect(result.valid).to.be.false
      const segmentAccessIssues = result.issues.filter((i) =>
        i.message.includes('Segment cannot have access "protected-env"'),
      )
      expect(segmentAccessIssues, JSON.stringify(result.issues)).to.have.length(1)
      expect(segmentAccessIssues[0].severity).to.equal('error')
    })

    for (const value of ['support', 'standard', 'protected-all-envs']) {
      it(`accepts segment access="${value}"`, () => {
        const result = validateFileMap(segmentWithAccess(value))
        expect(result.valid, JSON.stringify(result.issues)).to.be.true
        expect(result.issues).to.be.empty
      })
    }
  })
})
