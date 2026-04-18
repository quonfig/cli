/**
 * JSON Schema for Quonfig StoredConfig files.
 *
 * This is the machine-readable schema for files in configs/, feature-flags/,
 * segments/, and log-levels/. Written to `quonfig.schema.json` by `qfg init`.
 *
 * Derived from the Zod schemas in verify/validate.ts — keep in sync.
 */

const configTypes = ['config', 'feature_flag', 'log_level', 'segment'] as const
const valueTypes = ['bool', 'string', 'int', 'double', 'json', 'string_list', 'duration', 'log_level'] as const
const logLevels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

const operators = [
  'ALWAYS_TRUE',
  'PROP_IS_ONE_OF',
  'PROP_IS_NOT_ONE_OF',
  'PROP_STARTS_WITH_ONE_OF',
  'PROP_DOES_NOT_START_WITH_ONE_OF',
  'PROP_ENDS_WITH_ONE_OF',
  'PROP_DOES_NOT_END_WITH_ONE_OF',
  'PROP_CONTAINS_ONE_OF',
  'PROP_DOES_NOT_CONTAIN_ONE_OF',
  'PROP_LESS_THAN',
  'PROP_LESS_THAN_OR_EQUAL',
  'PROP_GREATER_THAN',
  'PROP_GREATER_THAN_OR_EQUAL',
  'PROP_BEFORE',
  'PROP_AFTER',
  'PROP_MATCHES',
  'PROP_DOES_NOT_MATCH',
  'IN_SEG',
  'NOT_IN_SEG',
  'IN_INT_RANGE',
  'LOOKUP_KEY_IN',
  'LOOKUP_KEY_NOT_IN',
] as const

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
        'ALWAYS_TRUE needs no extra fields. PROP_* operators require propertyName and valueToMatch. IN_SEG/NOT_IN_SEG require valueToMatch with segment key.',
    },
    propertyName: {
      type: 'string' as const,
      description: 'Required for PROP_* operators.',
    },
    valueToMatch: {
      ...simpleValue,
      description: 'Required for all operators except ALWAYS_TRUE.',
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
    key: {type: 'string' as const},
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
      accessLevel: {type: 'string'},
      protection: {type: 'string'},
      tags: {
        type: 'array',
        items: {type: 'string'},
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
