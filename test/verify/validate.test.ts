import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {ValidationIssue} from '../../src/verify/validate.js'

import {validateFileMap, validateKey, validateWorkspace} from '../../src/verify/validate.js'

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
    function configWithAccess(access?: unknown): Map<string, string> {
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
      const result = validateFileMap(configWithAccess())
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

  // qfg-6na9.4: FS-safety floor + case-insensitive duplicate detection.
  // See project/plans/26-06-tighter-naming.md ("FS-safety floor", "Length
  // cap: 200", "Case-insensitive uniqueness").
  describe('key FS-safety floor (qfg-6na9.4)', () => {
    // Exercise validateKey directly: the leading-dot case never reaches
    // validateKey via the file walk (dot-prefixed files are pre-filtered), and
    // the floor is a pure per-key constraint, so a direct call is the
    // confound-free unit.
    function floorErrors(key: string): ValidationIssue[] {
      const issues: ValidationIssue[] = []
      validateKey(key, `configs/${key}.json`, issues)
      return issues
    }

    const rejected: Array<[string, string, string]> = [
      ['leading dot', '.beta', 'leading dot'],
      ['control char', 'foo\u0001bar', 'control'],
      ['Windows-reserved char (feature:beta)', 'feature:beta', 'Windows-reserved'],
      ['Windows reserved device name (con)', 'con', 'reserved device name'],
      ['Windows reserved device name with extension (con.foo)', 'con.foo', 'reserved device name'],
      ['trailing space', 'foo ', 'trailing dot or space'],
      ['trailing dot', 'foo.', 'trailing dot or space'],
      ['201-character key', 'a'.repeat(201), '200 characters'],
    ]

    for (const [label, key, fragment] of rejected) {
      it(`rejects a key with a ${label}`, () => {
        const errors = floorErrors(key)
        expect(
          errors.some((i) => i.severity === 'error' && i.message.includes(fragment)),
          JSON.stringify(errors),
        ).to.be.true
      })
    }

    it('accepts a 200-character key', () => {
      expect(floorErrors('a'.repeat(200))).to.be.empty
    })

    it('accepts a clean lowercase key with no floor errors', () => {
      expect(floorErrors('my.clean-key_1')).to.be.empty
    })

    it('rejects feature:beta end-to-end via validateFileMap', () => {
      const result = validateFileMap(
        new Map<string, string>([
          [
            'configs/feature:beta.json',
            JSON.stringify({
              key: 'feature:beta',
              type: 'config',
              valueType: 'string',
              default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'a'}}]},
              environments: [],
              variants: [],
            }),
          ],
        ]),
      )
      expect(result.valid).to.be.false
      expect(result.issues.some((i) => i.message.includes('Windows-reserved'))).to.be.true
    })

    it('passes a clean lowercase workspace with no new floor errors', () => {
      const result = validateFileMap(
        new Map<string, string>([
          [
            'configs/my.clean-key_1.json',
            JSON.stringify({
              key: 'my.clean-key_1',
              type: 'config',
              valueType: 'string',
              default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'a'}}]},
              environments: [],
              variants: [],
            }),
          ],
        ]),
      )
      expect(result.valid, JSON.stringify(result.issues)).to.be.true
      expect(result.issues).to.be.empty
    })
  })

  describe('Policy A charset hard error (qfg-6na9.6)', () => {
    function keyIssues(key: string): ValidationIssue[] {
      const issues: ValidationIssue[] = []
      validateKey(key, `configs/${key}.json`, issues)
      return issues
    }

    it('ERRORS on a floor-clean charset violation', () => {
      for (const key of ['my key', 'feature@v2', 'a+b', 'café', ' leading-space']) {
        const issues = keyIssues(key)
        expect(
          issues.some((i) => i.severity === 'error' && /allowed set/i.test(i.message)),
          `${key}: ${JSON.stringify(issues)}`,
        ).to.be.true
      }
    })

    it('does not flag a conforming key (uppercase IS allowed by Policy A)', () => {
      for (const key of ['my.clean-key_1', 'CamelCase', 'A.B_c-1', 'SCREAMING_CASE']) {
        expect(keyIssues(key), key).to.be.empty
      }
    })

    it('does not double-report: a floor violation gets exactly one error, no extra charset issue', () => {
      const issues = keyIssues('feature:beta') // ':' is a Windows-reserved floor char
      expect(issues.some((i) => i.severity === 'error')).to.be.true
      expect(issues.some((i) => /allowed set/i.test(i.message))).to.be.false
    })

    it('a floor-clean charset-violating config now FAILS via validateFileMap', () => {
      const result = validateFileMap(
        new Map<string, string>([
          [
            'configs/my key.json',
            JSON.stringify({
              key: 'my key',
              type: 'config',
              valueType: 'string',
              default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'a'}}]},
              environments: [],
              variants: [],
            }),
          ],
        ]),
      )
      expect(result.valid, JSON.stringify(result.issues)).to.be.false
      expect(result.issues.some((i) => i.severity === 'error' && /allowed set/i.test(i.message))).to.be.true
    })
  })

  describe('case-insensitive duplicate detection (qfg-6na9.4)', () => {
    function twoConfigs(keyA: string, keyB: string): Map<string, string> {
      const mk = (key: string) => ({
        key,
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
      })
      return new Map<string, string>([
        [`configs/${keyA}.json`, JSON.stringify(mk(keyA))],
        [`configs/${keyB}.json`, JSON.stringify(mk(keyB))],
      ])
    }

    it('errors on a Foo/foo pair with the case-collision message', () => {
      const result = validateFileMap(twoConfigs('Foo', 'foo'))
      expect(result.valid).to.be.false
      const caseIssues = result.issues.filter((i) => i.message.includes('differ only by case'))
      expect(caseIssues, JSON.stringify(result.issues)).to.have.length(1)
      expect(caseIssues[0].severity).to.equal('error')
      expect(caseIssues[0].message).to.include('Foo')
      expect(caseIssues[0].message).to.include('foo')
    })

    it('errors on an exact duplicate with the duplicate-key message', () => {
      // Two files, same exact key, in different directories.
      const dupConfig = (dir: string) =>
        new Map<string, string>([
          [
            `${dir}/dup.json`,
            JSON.stringify({
              key: 'dup',
              type: dir === 'segments' ? 'segment' : 'config',
              valueType: dir === 'segments' ? 'bool' : 'string',
              ...(dir === 'segments' ? {sendToClientSdk: false} : {}),
              default: {
                rules: [
                  {
                    criteria: [{operator: 'ALWAYS_TRUE'}],
                    value: dir === 'segments' ? {type: 'bool', value: false} : {type: 'string', value: 'a'},
                  },
                ],
              },
              environments: [],
              variants: [],
            }),
          ],
        ])
      const files = new Map([...dupConfig('configs'), ...dupConfig('segments')])
      const result = validateFileMap(files)
      expect(result.valid).to.be.false
      const dupIssues = result.issues.filter((i) => i.message.includes('Duplicate key'))
      expect(dupIssues, JSON.stringify(result.issues)).to.have.length(1)
      expect(dupIssues[0].message).to.not.include('differ only by case')
    })

    it('detects a case collision via validateWorkspace', () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-case-'))
      try {
        fs.mkdirSync(path.join(workspace, 'configs'), {recursive: true})
        fs.mkdirSync(path.join(workspace, 'feature-flags'), {recursive: true})
        fs.writeFileSync(path.join(workspace, 'quonfig.json'), JSON.stringify({environments: []}, null, 2))
        const mkConfig = (key: string) =>
          JSON.stringify({
            key,
            type: 'config',
            valueType: 'string',
            default: {
              rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'a'}}],
            },
            environments: [],
            variants: [],
          })
        const mkFlag = (key: string) =>
          JSON.stringify({
            key,
            type: 'feature_flag',
            valueType: 'bool',
            default: {
              rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}],
            },
            environments: [],
            variants: [],
          })
        // Each file's key matches its filename and lives in the directory its
        // type requires; the two keys collide only case-insensitively. Distinct
        // directories so they don't overwrite each other on the case-insensitive
        // filesystem the test itself runs on (macOS).
        fs.writeFileSync(path.join(workspace, 'configs', 'MyFlag.json'), mkConfig('MyFlag'))
        fs.writeFileSync(path.join(workspace, 'feature-flags', 'myflag.json'), mkFlag('myflag'))

        const result = validateWorkspace(workspace)
        expect(result.valid).to.be.false
        const caseIssues = result.issues.filter((i) => i.message.includes('differ only by case'))
        expect(caseIssues, JSON.stringify(result.issues)).to.have.length(1)
      } finally {
        fs.rmSync(workspace, {recursive: true, force: true})
      }
    })
  })

  // qfg-hbuy.4: within the validated content dirs, an entry that is a
  // dotfile, a nested path, or a file not ending in lowercase ".json" used to
  // be silently SKIPPED by the enumeration filters — a "ghost" file that
  // pushes fine but is invisible to the hook and to every loader (and a
  // FOO.JSON can collide with foo.json on a case-insensitive customer clone).
  // All three are now hard errors at the committed-tree boundary.
  describe('ghost-file prevention (qfg-hbuy.4)', () => {
    const cleanConfig = (key: string) =>
      JSON.stringify({
        key,
        type: 'config',
        valueType: 'string',
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'a'}}]},
        environments: [],
        variants: [],
      })

    describe('validateFileMap (committed tree / hook boundary)', () => {
      it('errors on a dotfile inside a validated dir', () => {
        const result = validateFileMap(new Map([['configs/.evil.json', cleanConfig('.evil')]]))
        expect(result.valid, JSON.stringify(result.issues)).to.be.false
        expect(result.issues.some((i) => i.severity === 'error' && /dotfile/i.test(i.message))).to.be.true
      })

      it('errors on a nested path inside a validated dir', () => {
        const result = validateFileMap(new Map([['configs/sub/x.json', cleanConfig('x')]]))
        expect(result.valid, JSON.stringify(result.issues)).to.be.false
        expect(result.issues.some((i) => i.severity === 'error' && /subdirector/i.test(i.message))).to.be.true
      })

      it('errors on an uppercase .JSON extension inside a validated dir', () => {
        const result = validateFileMap(new Map([['configs/FOO.JSON', cleanConfig('FOO')]]))
        expect(result.valid, JSON.stringify(result.issues)).to.be.false
        expect(result.issues.some((i) => i.severity === 'error' && /lowercase "\.json"/i.test(i.message))).to.be.true
      })

      it('errors on a non-JSON file inside a validated dir', () => {
        const result = validateFileMap(new Map([['feature-flags/notes.txt', 'hello']]))
        expect(result.valid, JSON.stringify(result.issues)).to.be.false
        expect(result.issues.some((i) => i.severity === 'error' && /only "\.json" files/i.test(i.message))).to.be.true
      })

      it('does NOT flag legitimate non-config paths (.qf/, README.md, quonfig.json)', () => {
        const result = validateFileMap(
          new Map([
            ['.qf/key-plan.json', JSON.stringify({})],
            ['README.md', '# hi'],
            ['configs/clean-key.json', cleanConfig('clean-key')],
            ['quonfig.json', JSON.stringify({environments: []})],
          ]),
        )
        expect(result.valid, JSON.stringify(result.issues)).to.be.true
        expect(result.issues).to.be.empty
      })
    })

    describe('validateWorkspace (local disk walk)', () => {
      function ghostWorkspace(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-ghost-'))
        fs.mkdirSync(path.join(dir, 'configs'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'quonfig.json'), JSON.stringify({environments: []}, null, 2))
        fs.writeFileSync(path.join(dir, 'configs', 'clean-key.json'), cleanConfig('clean-key'))
        return dir
      }

      it('errors on a subdirectory inside a validated dir', () => {
        const dir = ghostWorkspace()
        try {
          fs.mkdirSync(path.join(dir, 'configs', 'sub'))
          fs.writeFileSync(path.join(dir, 'configs', 'sub', 'x.json'), cleanConfig('x'))
          const result = validateWorkspace(dir)
          expect(result.valid, JSON.stringify(result.issues)).to.be.false
          expect(result.issues.some((i) => i.severity === 'error' && /subdirector/i.test(i.message))).to.be.true
        } finally {
          fs.rmSync(dir, {recursive: true, force: true})
        }
      })

      it('errors on an uppercase .JSON extension', () => {
        const dir = ghostWorkspace()
        try {
          fs.writeFileSync(path.join(dir, 'configs', 'FOO.JSON'), cleanConfig('FOO'))
          const result = validateWorkspace(dir)
          expect(result.valid, JSON.stringify(result.issues)).to.be.false
          expect(result.issues.some((i) => i.severity === 'error' && /lowercase "\.json"/i.test(i.message))).to.be.true
        } finally {
          fs.rmSync(dir, {recursive: true, force: true})
        }
      })

      it('errors on a non-JSON file', () => {
        const dir = ghostWorkspace()
        try {
          fs.writeFileSync(path.join(dir, 'configs', 'notes.txt'), 'hello')
          const result = validateWorkspace(dir)
          expect(result.valid, JSON.stringify(result.issues)).to.be.false
          expect(result.issues.some((i) => i.severity === 'error' && /only "\.json" files/i.test(i.message))).to.be.true
        } finally {
          fs.rmSync(dir, {recursive: true, force: true})
        }
      })

      it('WARNS (not errors) on a .json-looking dotfile — inert on disk, never pushed', () => {
        // `qfg push` skips dotfiles entirely (collectFiles), so a local
        // configs/.evil.json can never reach the server from here — but it is
        // almost certainly a mistake, so surface it without blocking.
        const dir = ghostWorkspace()
        try {
          fs.writeFileSync(path.join(dir, 'configs', '.evil.json'), cleanConfig('.evil'))
          const result = validateWorkspace(dir)
          expect(result.valid, JSON.stringify(result.issues)).to.be.true
          expect(result.issues.some((i) => i.severity === 'warning' && /dotfile/i.test(i.message))).to.be.true
        } finally {
          fs.rmSync(dir, {recursive: true, force: true})
        }
      })

      it('silently ignores OS junk dotfiles (.DS_Store) and the .qf/ bookkeeping dir', () => {
        const dir = ghostWorkspace()
        try {
          fs.writeFileSync(path.join(dir, 'configs', '.DS_Store'), 'binaryish')
          fs.mkdirSync(path.join(dir, '.qf'))
          fs.writeFileSync(path.join(dir, '.qf', 'key-plan.json'), JSON.stringify({}))
          const result = validateWorkspace(dir)
          expect(result.valid, JSON.stringify(result.issues)).to.be.true
          expect(result.issues).to.be.empty
        } finally {
          fs.rmSync(dir, {recursive: true, force: true})
        }
      })
    })
  })

  // qfg-7jnb.8: IS_PRESENT / IS_NOT_PRESENT take only `propertyName` and
  // intentionally have no `valueToMatch`. Verify must accept both shapes.
  describe('presence operators (IS_PRESENT / IS_NOT_PRESENT)', () => {
    function flagWithPresence(operator: 'IS_PRESENT' | 'IS_NOT_PRESENT'): Map<string, string> {
      const flag = {
        key: 'gated-feature',
        type: 'feature_flag',
        valueType: 'bool',
        default: {
          rules: [
            {
              criteria: [{operator, propertyName: 'user.email'}],
              value: {type: 'bool', value: true},
            },
            {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
          ],
        },
        environments: [],
        variants: [],
      }
      return new Map<string, string>([['feature-flags/gated-feature.json', JSON.stringify(flag)]])
    }

    it('accepts a rule using IS_PRESENT with only propertyName (no valueToMatch)', () => {
      const result = validateFileMap(flagWithPresence('IS_PRESENT'))
      expect(result.valid, JSON.stringify(result.issues)).to.be.true
      expect(result.issues).to.be.empty
    })

    it('accepts a rule using IS_NOT_PRESENT with only propertyName (no valueToMatch)', () => {
      const result = validateFileMap(flagWithPresence('IS_NOT_PRESENT'))
      expect(result.valid, JSON.stringify(result.issues)).to.be.true
      expect(result.issues).to.be.empty
    })

    it('errors when IS_PRESENT is missing propertyName', () => {
      const flag = {
        key: 'gated-feature',
        type: 'feature_flag',
        valueType: 'bool',
        default: {
          rules: [
            {criteria: [{operator: 'IS_PRESENT'}], value: {type: 'bool', value: true}},
            {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
          ],
        },
        environments: [],
        variants: [],
      }
      const result = validateFileMap(new Map([['feature-flags/gated-feature.json', JSON.stringify(flag)]]))
      expect(result.valid).to.be.false
      const propIssues = result.issues.filter((i) => i.message.includes('requires propertyName'))
      expect(propIssues, JSON.stringify(result.issues)).to.have.length(1)
    })
  })

  describe('weight predicate (qfg-wis6.10)', () => {
    // Valid stored weights are exactly two forms: all-equal>0 (even split)
    // or a percent-scale sum of exactly 100000. Anything else was written
    // by a broken client and silently mis-serves traffic.
    function rolloutFlag(weights: number[]): Map<string, string> {
      return new Map([
        [
          'feature-flags/weighted.json',
          JSON.stringify({
            key: 'weighted',
            type: 'feature_flag',
            valueType: 'bool',
            default: {
              rules: [
                {
                  criteria: [{operator: 'ALWAYS_TRUE'}],
                  value: {
                    type: 'weighted_values',
                    value: {
                      weightedValues: weights.map((weight, i) => ({
                        value: {type: 'bool', value: i === 0},
                        weight,
                      })),
                      hashByPropertyName: 'user.key',
                    },
                  },
                },
              ],
            },
            environments: [],
            variants: [],
          }),
        ],
      ])
    }

    function weightIssues(weights: number[]) {
      return validateFileMap(rolloutFlag(weights)).issues.filter((i) => i.message.includes('even split'))
    }

    it('errors on the Form Health shape (100000/80000)', () => {
      const issues = weightIssues([100_000, 80_000])
      expect(issues).to.have.length(1)
      expect(issues[0].severity).to.equal('error')
      expect(issues[0].message).to.include('180000')
      expect(validateFileMap(rolloutFlag([100_000, 80_000])).valid).to.be.false
    })

    it('errors on all-zero weights', () => {
      const issues = weightIssues([0, 0])
      expect(issues).to.have.length(1)
      expect(issues[0].severity).to.equal('error')
    })

    it('accepts even-split ones (1/1 and 1/1/1)', () => {
      expect(validateFileMap(rolloutFlag([1, 1])).valid, JSON.stringify(weightIssues([1, 1]))).to.be.true
      expect(validateFileMap(rolloutFlag([1, 1, 1])).valid).to.be.true
    })

    it('accepts percent-scale sums (33333/33333/33334 and 100000/0)', () => {
      expect(validateFileMap(rolloutFlag([33_333, 33_333, 33_334])).valid).to.be.true
      expect(validateFileMap(rolloutFlag([100_000, 0])).valid).to.be.true
    })
  })

  // qfg-6sf7.10: a `default` block present but carrying no rules array is
  // the shape that 500'd GET /v1/segments and GET /v1/flags for a whole
  // workspace. app-quonfig's readers now degrade the row instead of dying,
  // but THIS is the gate that keeps the shape out of a repo in the first
  // place — pin it so the pre-receive hook can never be weakened into
  // accepting it.
  describe('default block must carry a rules array', () => {
    const withDefault = (path: string, type: string, defaultBlock: unknown) =>
      new Map<string, string>([
        [
          path,
          JSON.stringify({
            key: path.split('/')[1].replace('.json', ''),
            type,
            valueType: type === 'segment' ? 'bool' : 'string',
            default: defaultBlock,
            environments: [],
            variants: [],
          }),
        ],
      ])

    const rulesIssues = (files: Map<string, string>): ValidationIssue[] =>
      validateFileMap(files).issues.filter((i) => i.message.includes('default.rules'))

    it('rejects a segment whose default block is empty', () => {
      const files = withDefault('segments/broken.json', 'segment', {})

      expect(validateFileMap(files).valid).to.be.false

      const issues = rulesIssues(files)
      expect(issues).to.have.length(1)
      expect(issues[0].severity).to.equal('error')
    })

    it('rejects a segment whose default.rules is not an array', () => {
      const files = withDefault('segments/broken.json', 'segment', {rules: null})

      expect(validateFileMap(files).valid).to.be.false
      expect(rulesIssues(files)).to.have.length(1)
    })

    it('rejects a config and a flag with the same empty default block', () => {
      expect(validateFileMap(withDefault('configs/broken.json', 'config', {})).valid).to.be.false
      expect(validateFileMap(withDefault('feature-flags/broken.json', 'feature_flag', {})).valid).to.be.false
    })

    it('accepts an empty rules array — no rules is legitimate, no rules KEY is not', () => {
      expect(validateFileMap(withDefault('segments/fine.json', 'segment', {rules: []})).valid).to.be.true
    })
  })
})

// qfg-phcv: JSON values bound to a schema are validated with Ajv, behind the
// `validateValues` option. CLI callers and the pre-receive hook
// (standalone.ts, since qfg-q5f6.10 / W1b) turn it on; the library default is off.
describe('schema-bound JSON value validation (qfg-phcv)', () => {
  const jevSchema = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jev-questions.schema.json'),
      'utf8',
    ),
  )

  const retrySchema = {
    type: 'object',
    required: ['retries'],
    properties: {retries: {type: 'integer', minimum: 1}, mode: {enum: ['fast', 'slow']}},
    additionalProperties: false,
  }

  const always = [{operator: 'ALWAYS_TRUE'}]
  const json = (value: unknown) => ({type: 'json', value})

  function config(key: string, extra: Record<string, unknown>): string {
    return JSON.stringify({
      key,
      type: 'config',
      valueType: 'json',
      schemaKey: 'retry',
      default: {rules: [{criteria: always, value: json({retries: 1})}]},
      environments: [],
      variants: [],
      ...extra,
    })
  }

  function files(entries: Record<string, unknown>): Map<string, string> {
    const map = new Map<string, string>([
      ['quonfig.json', JSON.stringify({environments: ['production']})],
      ['schemas/retry.json', JSON.stringify(retrySchema)],
    ])
    for (const [p, content] of Object.entries(entries)) {
      map.set(p, typeof content === 'string' ? content : JSON.stringify(content))
    }

    return map
  }

  function writeToDisk(map: Map<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-values-'))
    for (const [rel, content] of map) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
      fs.writeFileSync(path.join(dir, rel), content)
    }

    return dir
  }

  /** Error messages from BOTH validate paths, which must agree. */
  function errorsBothPaths(map: Map<string, string>, validateValues = true): string[] {
    const fromMap = validateFileMap(map, {validateValues})
      .issues.filter((i) => i.severity === 'error')
      .map((i) => `${i.file}: ${i.message}`)
    const dir = writeToDisk(map)
    try {
      const fromDisk = validateWorkspace(dir, {validateValues})
        .issues.filter((i) => i.severity === 'error')
        .map((i) => `${i.file}: ${i.message}`)
      expect(fromDisk).to.deep.equal(fromMap)
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }

    return fromMap
  }

  it('a valid bound value passes', () => {
    expect(errorsBothPaths(files({'configs/retry-policy.json': config('retry-policy', {})}))).to.deep.equal([])
  })

  it('is OFF by default: an invalid value passes when validateValues is not set', () => {
    const map = files({
      'configs/retry-policy.json': config('retry-policy', {
        default: {rules: [{criteria: always, value: json({retries: 'three'})}]},
      }),
    })
    expect(validateFileMap(map).valid).to.equal(true)
    const dir = writeToDisk(map)
    try {
      expect(validateWorkspace(dir).valid).to.equal(true)
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }

    expect(errorsBothPaths(map)).to.have.length(1)
  })

  it('reports every violation with the document path of the value plus the path inside it', () => {
    const map = files({
      'configs/retry-policy.json': config('retry-policy', {
        default: {rules: [{criteria: always, value: json({retries: 0, mode: 'turbo', extra: 1})}]},
      }),
    })
    expect(errorsBothPaths(map)).to.deep.equal([
      `configs/retry-policy.json: Value does not match schema "retry": default.rules[0].value: must NOT have additional property 'extra'`,
      `configs/retry-policy.json: Value does not match schema "retry": default.rules[0].value.retries: must be >= 1`,
      `configs/retry-policy.json: Value does not match schema "retry": default.rules[0].value.mode: must be equal to one of the allowed values: fast, slow`,
    ])
  })

  it('checks environment rules, weighted-value variants and top-level variants', () => {
    const good = json({retries: 2})
    const bad = json({retries: 'x'})
    const map = files({
      'configs/retry-policy.json': config('retry-policy', {
        default: {rules: [{criteria: always, value: good}]},
        environments: [
          {
            id: 'production',
            rules: [
              {
                criteria: always,
                value: {
                  type: 'weighted_values',
                  value: {
                    hashByPropertyName: 'user.key',
                    weightedValues: [
                      {value: good, weight: 50_000},
                      {value: bad, weight: 50_000},
                    ],
                  },
                },
              },
            ],
          },
        ],
        variants: [
          {key: 'good', value: good},
          {key: 'bad', value: bad},
        ],
      }),
    })
    expect(errorsBothPaths(map)).to.deep.equal([
      `configs/retry-policy.json: Value does not match schema "retry": environments[0].rules[0].value.value.weightedValues[1].value.retries: must be integer`,
      `configs/retry-policy.json: Value does not match schema "retry": variants[1].value.retries: must be integer`,
    ])
  })

  it('skips provided values, feature flags with a schemaKey, and non-json configs', () => {
    const map = files({
      'configs/provided.json': config('provided', {
        default: {rules: [{criteria: always, value: {type: 'provided', value: {lookup: 'RETRY', source: 'ENV_VAR'}}}]},
      }),
      'configs/as-string.json': config('as-string', {
        valueType: 'string',
        default: {rules: [{criteria: always, value: {type: 'string', value: 'nope'}}]},
      }),
      'feature-flags/flag-with-schema.json': config('flag-with-schema', {
        type: 'feature_flag',
        default: {rules: [{criteria: always, value: json({retries: 'x'})}]},
      }),
    })
    expect(errorsBothPaths(map)).to.deep.equal([])
  })

  it('finds schemas in schemas-protected/', () => {
    const map = files({
      'schemas-protected/locked.json': JSON.stringify(retrySchema),
      'configs/locked-policy.json': config('locked-policy', {
        schemaKey: 'locked',
        default: {rules: [{criteria: always, value: json({})}]},
      }),
    })
    expect(errorsBothPaths(map)).to.deep.equal([
      `configs/locked-policy.json: Value does not match schema "locked": default.rules[0].value: must have required property 'retries'`,
    ])
  })

  it('a schema that does not compile is ONE error on the schema file, bound or not', () => {
    const map = files({
      'schemas/broken.json': JSON.stringify({type: 'object', properties: {level: {enum: []}}}),
      'schemas/unbound-broken.json': JSON.stringify({type: 'object', properties: {level: {enum: []}}}),
      'configs/uses-broken.json': config('uses-broken', {
        schemaKey: 'broken',
        environments: [{id: 'production', rules: [{criteria: always, value: json({})}]}],
        default: {rules: [{criteria: always, value: json({})}]},
      }),
    })
    expect(errorsBothPaths(map)).to.deep.equal([
      `schemas/broken.json: schema broken is invalid: enum must have non-empty array`,
      `schemas/unbound-broken.json: schema unbound-broken is invalid: enum must have non-empty array`,
    ])
  })

  it('does not compile schemas when value validation is off (hook mode until phase 1b)', () => {
    const map = files({
      'schemas/unbound-broken.json': JSON.stringify({type: 'object', properties: {level: {enum: []}}}),
    })
    expect(errorsBothPaths(map, false)).to.deep.equal([])
  })

  it('a missing schema is only the existing reference error', () => {
    const map = files({
      'configs/orphan.json': config('orphan', {schemaKey: 'nope'}),
    })
    expect(errorsBothPaths(map)).to.deep.equal([`configs/orphan.json: References schema "nope" which does not exist`])
  })

  it('collapses tagged oneOf errors in the Jev schema to one message per question', () => {
    const map = files({
      'schemas/jev-questions.json': JSON.stringify(jevSchema),
      'configs/jev.json': config('jev', {
        schemaKey: 'jev-questions',
        default: {
          rules: [
            {
              criteria: always,
              value: json({
                questions: {
                  tone: {criteria: ['low', 'high']},
                  mood: {type: 'score', criteria: ['low']},
                  topic: {type: 'choice', criteria: {a: 'A', b: 'B'}},
                },
              }),
            },
          ],
        },
      }),
    })
    expect(errorsBothPaths(map)).to.deep.equal([
      'configs/jev.json: Value does not match schema "jev-questions": default.rules[0].value.questions.tone: `type` must be one of noul, score, choice',
      'configs/jev.json: Value does not match schema "jev-questions": default.rules[0].value.questions.mood.criteria: must NOT have fewer than 2 items',
    ])
  })
})

describe('reference cycle detection (qfg-9dxb.11)', () => {
  const always = [{operator: 'ALWAYS_TRUE'}]

  function segment(key: string, refs: Array<{op?: string; to: string | string[]}>): string {
    const rules = refs.map(({op = 'IN_SEG', to}) => ({
      criteria: [
        {
          operator: op,
          valueToMatch: Array.isArray(to) ? {type: 'string_list', value: to} : {type: 'string', value: to},
        },
      ],
      value: {type: 'bool', value: true},
    }))
    rules.push({criteria: always as never, value: {type: 'bool', value: false}})
    return JSON.stringify({key, type: 'segment', valueType: 'bool', default: {rules}, environments: [], variants: []})
  }

  function secret(key: string, decryptWith: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {type: 'string', value: 'ciphertext', confidential: true, decryptWith, ...extra}
  }

  function config(key: string, value: unknown, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      key,
      type: 'config',
      valueType: 'string',
      default: {rules: [{criteria: always, value}]},
      environments: [],
      variants: [],
      ...extra,
    })
  }

  function files(entries: Record<string, string>): Map<string, string> {
    return new Map<string, string>([
      ['quonfig.json', JSON.stringify({environments: ['production']})],
      ...Object.entries(entries),
    ])
  }

  /** Error messages from BOTH validate paths, which must agree. */
  function errorsBothPaths(map: Map<string, string>): string[] {
    const fromMap = validateFileMap(map)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => `${i.file}: ${i.message}`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-cycles-'))
    try {
      for (const [rel, content] of map) {
        fs.mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
        fs.writeFileSync(path.join(dir, rel), content)
      }

      const fromDisk = validateWorkspace(dir)
        .issues.filter((i) => i.severity === 'error')
        .map((i) => `${i.file}: ${i.message}`)
      expect(fromDisk).to.deep.equal(fromMap)
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }

    return fromMap
  }

  describe('segments', () => {
    it('rejects a segment that references itself', () => {
      const map = files({'segments/seg-a.json': segment('seg-a', [{to: 'seg-a'}])})
      expect(errorsBothPaths(map)).to.deep.equal(['segments/seg-a.json: Segment reference cycle: seg-a -> seg-a'])
    })

    it('rejects a two-segment cycle once, anchored on the first key', () => {
      const map = files({
        'segments/seg-a.json': segment('seg-a', [{to: 'seg-b'}]),
        'segments/seg-b.json': segment('seg-b', [{op: 'NOT_IN_SEG', to: 'seg-a'}]),
      })
      expect(errorsBothPaths(map)).to.deep.equal([
        'segments/seg-a.json: Segment reference cycle: seg-a -> seg-b -> seg-a',
      ])
    })

    it('rejects a three-segment cycle through a string_list reference', () => {
      const map = files({
        'segments/seg-a.json': segment('seg-a', [{to: 'seg-b'}]),
        'segments/seg-b.json': segment('seg-b', [{to: ['seg-x', 'seg-c']}]),
        'segments/seg-c.json': segment('seg-c', [{to: 'seg-a'}]),
        'segments/seg-x.json': segment('seg-x', []),
      })
      expect(errorsBothPaths(map)).to.deep.equal([
        'segments/seg-a.json: Segment reference cycle: seg-a -> seg-b -> seg-c -> seg-a',
      ])
    })

    it('accepts acyclic chains and diamonds', () => {
      const map = files({
        'segments/seg-a.json': segment('seg-a', [{to: 'seg-b'}, {to: 'seg-c'}]),
        'segments/seg-b.json': segment('seg-b', [{to: 'seg-d'}]),
        'segments/seg-c.json': segment('seg-c', [{op: 'NOT_IN_SEG', to: 'seg-d'}]),
        'segments/seg-d.json': segment('seg-d', []),
      })
      expect(errorsBothPaths(map)).to.deep.equal([])
    })
  })

  describe('decryptWith', () => {
    it('rejects a key config decrypted with itself', () => {
      const map = files({'configs/enc-key.json': config('enc-key', secret('enc-key', 'enc-key'))})
      expect(errorsBothPaths(map)).to.deep.equal(['configs/enc-key.json: decryptWith cycle: enc-key -> enc-key'])
    })

    it('rejects a cycle reached through an environment rule and a weighted value', () => {
      const map = files({
        'configs/key-a.json': config(
          'key-a',
          {type: 'string', value: 'plain'},
          {
            environments: [{id: 'production', rules: [{criteria: always, value: secret('key-a', 'key-b')}]}],
          },
        ),
        'configs/key-b.json': config(
          'key-b',
          {
            type: 'weighted_values',
            value: {weightedValues: [{weight: 1, value: secret('key-b', 'key-a')}], hashByPropertyName: 'user.key'},
          },
          {variants: [{value: {type: 'string', value: 'ciphertext'}}]},
        ),
      })
      expect(errorsBothPaths(map)).to.deep.equal(['configs/key-a.json: decryptWith cycle: key-a -> key-b -> key-a'])
    })

    it('accepts a secret decrypted with a plain key config', () => {
      const map = files({
        'configs/a.secret.json': config('a.secret', secret('a.secret', 'enc-key')),
        'configs/enc-key.json': config('enc-key', {type: 'string', value: 'plaintext-key'}),
      })
      expect(errorsBothPaths(map)).to.deep.equal([])
    })

    it('ignores decryptWith on a non-confidential value (SDKs do not follow it)', () => {
      const map = files({
        'configs/enc-key.json': config('enc-key', secret('enc-key', 'enc-key', {confidential: false})),
      })
      expect(errorsBothPaths(map)).to.deep.equal([])
    })
  })
})

describe('integer map key order warning (qfg-e87r.21)', () => {
  // Tenant id -> list of hidden iors. Keys are chosen by the author.
  const mapSchema = {
    type: 'object',
    properties: {
      hiddenIorsByTenant: {type: 'object', additionalProperties: {type: 'integer'}},
      fixed: {type: 'object', properties: {b: {type: 'integer'}, a: {type: 'integer'}, 5: {type: 'integer'}}},
      nested: {
        type: 'object',
        additionalProperties: {type: 'object', additionalProperties: {type: 'integer'}},
      },
    },
  }

  /** Build the config file TEXT by hand: JSON.stringify would reorder integer keys already. */
  function configText(valueText: string): string {
    return `{
  "key": "tenant-map",
  "type": "config",
  "valueType": "json",
  "schemaKey": "tenants",
  "default": {"rules": [{"criteria": [{"operator": "ALWAYS_TRUE"}], "value": {"type": "json", "value": ${valueText}}}]},
  "environments": [],
  "variants": []
}`
  }

  function warnings(valueText: string): string[] {
    const map = new Map<string, string>([
      ['configs/tenant-map.json', configText(valueText)],
      ['quonfig.json', JSON.stringify({environments: []})],
      ['schemas/tenants.json', JSON.stringify(mapSchema)],
    ])
    const fromMap = validateFileMap(map, {validateValues: true})
    expect(fromMap.valid, JSON.stringify(fromMap.issues)).to.be.true
    const messages = fromMap.issues.filter((i) => i.severity === 'warning').map((i) => `${i.file}: ${i.message}`)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quonfig-verify-keyorder-'))
    try {
      for (const [rel, content] of map) {
        fs.mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
        fs.writeFileSync(path.join(dir, rel), content)
      }

      const fromDisk = validateWorkspace(dir, {validateValues: true})
      expect(fromDisk.valid).to.be.true
      expect(
        fromDisk.issues.filter((i) => i.severity === 'warning').map((i) => `${i.file}: ${i.message}`),
      ).to.deep.equal(messages)
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }

    return messages
  }

  it('warns when an integer key is not first', () => {
    expect(warnings('{"hiddenIorsByTenant": {"b": 2, "a": 1, "5": 0}}')).to.deep.equal([
      'configs/tenant-map.json: map at default.rules[0].value.hiddenIorsByTenant has integer keys ("5") that aren\'t first, in ascending order. Saving from the app moves them to the front. Reorder them here to avoid a one-time diff.',
    ])
  })

  it('does not warn when integer keys are already first', () => {
    expect(warnings('{"hiddenIorsByTenant": {"5": 0, "b": 2, "a": 1}}')).to.deep.equal([])
  })

  it('warns when integer keys are first but not ascending', () => {
    const result = warnings('{"hiddenIorsByTenant": {"10": 1, "5": 0, "a": 2}}')
    expect(result).to.have.length(1)
    expect(result[0]).to.include('("10", "5")')
  })

  it('does not warn for a map with no integer keys', () => {
    expect(warnings('{"hiddenIorsByTenant": {"b": 2, "a": 1}}')).to.deep.equal([])
  })

  it('does not treat "007", "-1", "1.5", "5a" or 4294967295 as integer keys', () => {
    expect(
      warnings('{"hiddenIorsByTenant": {"b": 2, "007": 1, "-1": 0, "1.5": 3, "5a": 4, "4294967295": 5}}'),
    ).to.deep.equal([])
  })

  it('warns on a nested map with the right path', () => {
    expect(warnings('{"nested": {"acme": {"x": 1, "3": 2}, "7": {"1": 1}}}')).to.deep.equal([
      'configs/tenant-map.json: map at default.rules[0].value.nested has integer keys ("7") that aren\'t first, in ascending order. Saving from the app moves them to the front. Reorder them here to avoid a one-time diff.',
      'configs/tenant-map.json: map at default.rules[0].value.nested.acme has integer keys ("3") that aren\'t first, in ascending order. Saving from the app moves them to the front. Reorder them here to avoid a one-time diff.',
    ])
  })

  it('never warns on an object whose keys are fixed by the schema', () => {
    expect(warnings('{"fixed": {"b": 2, "a": 1, "5": 0}}')).to.deep.equal([])
  })
})
