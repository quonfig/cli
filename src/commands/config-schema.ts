import {Flags} from '@oclif/core'

import {BaseCommand} from '../index.js'
import {JsonObj} from '../result.js'
import {storedConfigJsonSchema} from '../init/schema.js'

export const REFERENCE = `
────────────────────────────────────────────────────────────
FILE LAYOUT
────────────────────────────────────────────────────────────
Config files live in your workspace (clone with: qfg pull --dir ./my-config):

  feature-flags/   Boolean feature flags (on/off, targeting, percentage rollouts)
  configs/         Typed config values (string, int, double, json, string-list)
  segments/        User segments for targeting rules
  log-levels/      Dynamic log-level configs

────────────────────────────────────────────────────────────
RULE EVALUATION
────────────────────────────────────────────────────────────
Rules are evaluated in ORDER — the FIRST matching rule wins.
Put specific rules (user lists, segments) BEFORE catch-all rules.
  criteria: []   means "match everyone" (unconditional / catch-all)
  criteria: [..] multiple entries in one rule are ANDed together

────────────────────────────────────────────────────────────
EXAMPLE: complex targeting + rollout in production
────────────────────────────────────────────────────────────
Four rules in order:
  1. Always ON  for users in an allowlist
  2. Always ON  for users in the "beta" segment
  3. Always OFF for users in the "holdout" segment
  4. 50/50 split for everyone else

  {
    "key": "my.feature.flag",
    "type": "feature_flag",
    "valueType": "bool",
    "default": {
      "rules": [{ "criteria": [], "value": { "type": "bool", "value": false } }]
    },
    "environments": [{
      "id": "production",
      "rules": [
        {
          "criteria": [{
            "operator": "PROP_IS_ONE_OF",
            "propertyName": "user.key",
            "valueToMatch": { "type": "string_list", "value": ["user-123", "user-456"] }
          }],
          "value": { "type": "bool", "value": true }
        },
        {
          "criteria": [{
            "operator": "IN_SEG",
            "valueToMatch": { "type": "string", "value": "beta" }
          }],
          "value": { "type": "bool", "value": true }
        },
        {
          "criteria": [{
            "operator": "IN_SEG",
            "valueToMatch": { "type": "string", "value": "holdout" }
          }],
          "value": { "type": "bool", "value": false }
        },
        {
          "criteria": [],
          "value": {
            "type": "weighted_values",
            "value": {
              "hashByPropertyName": "user.key",
              "weightedValues": [
                { "value": { "type": "bool", "value": true },  "weight": 50000 },
                { "value": { "type": "bool", "value": false }, "weight": 50000 }
              ]
            }
          }
        }
      ]
    }]
  }

────────────────────────────────────────────────────────────
CRITERION FIELDS
────────────────────────────────────────────────────────────
Each criterion object has:
  operator        (required) — see operator table below
  propertyName    (required for PROP_* operators) — user property, e.g. "user.key", "user.plan"
  valueToMatch    (required for all except ALWAYS_TRUE / IS_PRESENT / IS_NOT_PRESENT) — typed value to compare against

────────────────────────────────────────────────────────────
OPERATOR REFERENCE
────────────────────────────────────────────────────────────
  Operator                         valueToMatch type    Notes
  ────────────────────────────────────────────────────────
  ALWAYS_TRUE                      (none)               Unconditional match; use for catch-all rules
  PROP_IS_ONE_OF                   string_list          propertyName value is in the list
  PROP_IS_NOT_ONE_OF               string_list          propertyName value is NOT in the list
  PROP_STARTS_WITH_ONE_OF          string_list          string prefix match
  PROP_DOES_NOT_START_WITH_ONE_OF  string_list
  PROP_ENDS_WITH_ONE_OF            string_list          string suffix match
  PROP_DOES_NOT_END_WITH_ONE_OF    string_list
  PROP_CONTAINS_ONE_OF             string_list          substring match
  PROP_DOES_NOT_CONTAIN_ONE_OF     string_list
  PROP_LESS_THAN                   int or double        numeric comparison
  PROP_LESS_THAN_OR_EQUAL          int or double
  PROP_GREATER_THAN                int or double
  PROP_GREATER_THAN_OR_EQUAL       int or double
  PROP_SEMVER_LESS_THAN            string               semver comparison; valueToMatch is a semver string like "4.0.9"
  PROP_SEMVER_EQUAL                string               semver comparison; valueToMatch is a semver string like "4.0.9"
  PROP_SEMVER_GREATER_THAN         string               semver comparison; valueToMatch is a semver string like "4.0.9"
  PROP_BEFORE                      string (ISO 8601)    date/time comparison
  PROP_AFTER                       string (ISO 8601)
  PROP_MATCHES                     string               regex match
  PROP_DOES_NOT_MATCH              string
  IS_PRESENT                       (none)               propertyName is set on the evaluation context (no valueToMatch)
  IS_NOT_PRESENT                   (none)               propertyName is missing from the evaluation context (no valueToMatch)
  IN_SEG                           string               value = segment key (no propertyName needed)
  NOT_IN_SEG                       string               value = segment key (no propertyName needed)
  IN_INT_RANGE                     int_range            value = {min, max}
  LOOKUP_KEY_IN                    string_list          matches if SDK lookup key is in the list
  LOOKUP_KEY_NOT_IN                string_list

valueToMatch format: { "type": "<type>", "value": <value> }
  string_list  →  { "type": "string_list", "value": ["a", "b"] }
  string       →  { "type": "string",      "value": "beta" }
  int          →  { "type": "int",         "value": 42 }
  double       →  { "type": "double",      "value": 3.14 }

────────────────────────────────────────────────────────────
PERCENTAGE ROLLOUT (weighted_values)
────────────────────────────────────────────────────────────
Weights are integers out of 100,000 (not percentages):
  5%=5000  10%=10000  20%=20000  50%=50000  100%=100000
  All weights in one rule MUST sum to exactly 100,000.

hashByPropertyName controls the bucket assignment property (default: "user.key").

────────────────────────────────────────────────────────────
RELATED COMMANDS
────────────────────────────────────────────────────────────
  qfg create my.flag --type boolean-flag          create a new flag
  qfg set-default my.flag --environment prod ...  set a scalar fallback value
  qfg set-rollout my.flag --environment prod ...  set a simple percentage rollout
  qfg pull --dir ./config                         clone workspace to edit JSON directly
  qfg verify ./config                             validate all JSON files before pushing
  qfg info my.flag                                inspect current values and rules
  qfg config-schema --json-schema                 print the machine-readable JSON Schema
`.trim()

export default class ConfigSchema extends BaseCommand {
  static description =
    'Print the config file format reference: rules engine, operators, targeting criteria, segments, and weighted rollouts. ' +
    'Use --json-schema for the machine-readable JSON Schema document.'

  static examples = [
    '<%= config.bin %> <%= command.id %>                  # human-readable operator reference + examples',
    '<%= config.bin %> <%= command.id %> --json-schema    # full JSON Schema document (copy into your editor)',
  ]

  static flags = {
    'json-schema': Flags.boolean({
      default: false,
      description: 'Output the full JSON Schema document for config files instead of the human-readable reference',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(ConfigSchema)

    if (flags['json-schema']) {
      const schema = storedConfigJsonSchema()
      this.log(JSON.stringify(schema, null, 2))
      return schema as JsonObj
    }

    this.log(REFERENCE)
  }
}
