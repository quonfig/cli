/**
 * JSON Schema for Quonfig StoredConfig files.
 *
 * This is the machine-readable schema for files in configs/, feature-flags/,
 * segments/, and log-levels/. Served at api.quonfig.com/schemas/v1/stored-config.json
 * and printed by `qfg config-schema --json-schema`.
 *
 * Derived from the Zod schemas in verify/validate.ts — keep in sync.
 */

import {OPERATORS as operators} from '../verify/validate.js'

const configTypes = ['config', 'feature_flag', 'log_level', 'segment'] as const
const valueTypes = ['bool', 'string', 'int', 'double', 'json', 'string_list', 'duration', 'log_level'] as const
const logLevels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

// ── Value sub-schemas ──────────────────────────────────────────────────

const boolValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'bool'},
    value: {type: 'boolean' as const},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const stringValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'string'},
    value: {type: 'string' as const},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const intValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'int'},
    value: {oneOf: [{type: 'number' as const}, {type: 'string' as const}]},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const doubleValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'double'},
    value: {oneOf: [{type: 'number' as const}, {type: 'string' as const}]},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const jsonValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'json'},
    value: {},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const stringListValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'string_list'},
    value: {type: 'array' as const, items: {type: 'string' as const}},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const durationValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'duration'},
    value: {type: 'string' as const, description: 'Go-style duration (e.g. "30s", "5m", "1h30m")'},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const logLevelValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'log_level'},
    value: {enum: [...logLevels]},
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const schemaValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'schema'},
    value: {
      type: 'object' as const,
      properties: {
        schemaType: {type: 'string' as const},
        schema: {type: 'string' as const},
      },
      required: ['schemaType', 'schema'],
    },
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const providedValue = {
  type: 'object' as const,
  properties: {
    type: {const: 'provided'},
    value: {
      type: 'object' as const,
      properties: {
        source: {type: 'string' as const},
        lookup: {type: 'string' as const},
      },
      required: ['source', 'lookup'],
    },
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const simpleValue = {
  oneOf: [
    boolValue,
    stringValue,
    intValue,
    doubleValue,
    jsonValue,
    stringListValue,
    durationValue,
    logLevelValue,
    schemaValue,
    providedValue,
  ],
}

const weightedValuesValue = {
  type: 'object' as const,
  description: 'Weighted rollout for A/B testing. Weights are out of 100,000.',
  properties: {
    type: {const: 'weighted_values'},
    value: {
      type: 'object' as const,
      properties: {
        weightedValues: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              value: simpleValue,
              weight: {type: 'integer' as const, minimum: 0, maximum: 100_000},
            },
            required: ['value', 'weight'],
            additionalProperties: false,
          },
        },
        hashByPropertyName: {type: 'string' as const, default: 'user.key'},
        splitEvenly: {type: 'boolean' as const},
      },
      required: ['weightedValues'],
      additionalProperties: false,
    },
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const ruleValue = {
  oneOf: [...simpleValue.oneOf, weightedValuesValue],
}

// ── Criterion ──────────────────────────────────────────────────────────

const criterion = {
  type: 'object' as const,
  properties: {
    operator: {
      enum: [...operators],
      description:
        'ALWAYS_TRUE needs no extra fields. PROP_* operators require propertyName and valueToMatch. IS_PRESENT/IS_NOT_PRESENT take only propertyName (no valueToMatch). IN_SEG/NOT_IN_SEG require valueToMatch with segment key.',
    },
    propertyName: {
      type: 'string' as const,
      description: 'Required for PROP_* and IS_PRESENT/IS_NOT_PRESENT operators.',
    },
    valueToMatch: {
      ...simpleValue,
      description: 'Required for all operators except ALWAYS_TRUE / IS_PRESENT / IS_NOT_PRESENT.',
    },
  },
  required: ['operator'],
  additionalProperties: false,
}

// ── Rule ───────────────────────────────────────────────────────────────

const configRule = {
  type: 'object' as const,
  description: 'Rules are evaluated in order; first match wins. All criteria within a rule are ANDed.',
  properties: {
    criteria: {
      type: 'array' as const,
      items: criterion,
    },
    value: ruleValue,
  },
  required: ['criteria', 'value'],
  additionalProperties: false,
}

// ── Environment ────────────────────────────────────────────────────────

const configEnvironment = {
  type: 'object' as const,
  properties: {
    id: {
      type: 'string' as const,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
      description: 'Lowercase slug (e.g. "production", "staging"). Must NOT be a UUID.',
    },
    rules: {
      type: 'array' as const,
      items: configRule,
    },
  },
  required: ['id', 'rules'],
  additionalProperties: false,
}

// ── Variant ────────────────────────────────────────────────────────────

const variant = {
  type: 'object' as const,
  properties: {
    id: {type: 'string' as const},
    name: {type: 'string' as const},
    value: simpleValue,
    description: {type: 'string' as const},
  },
  required: ['value'],
  additionalProperties: false,
}

// ── Top-level StoredConfig ─────────────────────────────────────────────

export function storedConfigJsonSchema(): object {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://quonfig.com/schemas/stored-config.json',
    title: 'Quonfig StoredConfig',
    description: 'Schema for config files in a Quonfig workspace (configs/, feature-flags/, segments/, log-levels/).',
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        not: {const: 'new'},
        pattern: '^[^/\\\\]+$',
        description: 'Unique identifier. Must match the filename (without .json).',
      },
      type: {
        enum: [...configTypes],
        description:
          'Determines which directory the file lives in: config→configs/, feature_flag→feature-flags/, segment→segments/, log_level→log-levels/.',
      },
      valueType: {
        enum: [...valueTypes],
        description:
          'The value type. Must match the "type" field in rule values. Segments must use "bool". Log levels must use "log_level".',
      },
      default: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            items: configRule,
            minItems: 1,
          },
        },
        required: ['rules'],
        additionalProperties: false,
      },
      id: {type: 'string'},
      projectId: {type: 'string'},
      name: {type: 'string'},
      description: {type: 'string'},
      sendToClientSdk: {
        type: 'boolean',
        default: false,
        description: 'Whether to expose this config to client-side SDKs. Must be false for segments.',
      },
      schemaKey: {
        type: 'string',
        description: 'References a schema in schemas/ or schemas-protected/. The referenced file must exist.',
      },
      access: {
        enum: ['support', 'standard', 'protected-env', 'protected-all-envs'],
        description: 'Edit-access tier for this config. Defaults to "standard" when absent. See protecting-access.md.',
      },
      tags: {
        type: 'array',
        items: {type: 'string'},
      },
      readyForCleanup: {
        type: 'boolean',
        description:
          'Owner-supplied lifecycle marker (qfg-580q). When true on a feature_flag, the UI shows "Ready for cleanup" instead of the rule-derived status — signaling the flag is safe to remove from code.',
      },
      environments: {
        type: 'array',
        items: configEnvironment,
        default: [],
      },
      variants: {
        type: 'array',
        items: variant,
        default: [],
      },
    },
    required: ['key', 'type', 'valueType', 'default'],
    additionalProperties: true,

    // Type-specific constraints (JSON Schema if/then/else — not Promise thenables)
    allOf: [
      {
        if: {properties: {type: {const: 'segment'}}},
        // eslint-disable-next-line unicorn/no-thenable
        then: {
          properties: {
            valueType: {const: 'bool'},
            sendToClientSdk: {const: false},
          },
        },
      },
      {
        if: {properties: {type: {const: 'log_level'}}},
        // eslint-disable-next-line unicorn/no-thenable
        then: {
          properties: {
            valueType: {const: 'log_level'},
          },
        },
      },
    ],
  }
}
