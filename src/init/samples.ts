/**
 * Sample config data for `qfg init --samples`.
 *
 * Each entry maps a relative path (e.g. "configs/example.greeting.json")
 * to the JSON object that should be written there.
 */

export interface SampleFile {
  path: string
  content: object
}

export const SAMPLE_FILES: SampleFile[] = [
  {
    path: 'configs/example.greeting.json',
    content: {
      key: 'example.greeting',
      type: 'config',
      valueType: 'string',
      sendToClientSdk: true,
      description: 'A greeting message shown to users.',
      default: {
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'string', value: 'Hello, world!'},
          },
        ],
      },
      environments: [
        {
          id: 'production',
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'string', value: 'Welcome to our app!'},
            },
          ],
        },
      ],
      variants: [],
    },
  },
  {
    path: 'feature-flags/example.dark-mode.json',
    content: {
      key: 'example.dark-mode',
      type: 'feature_flag',
      valueType: 'bool',
      sendToClientSdk: true,
      description: 'Enable dark mode UI.',
      default: {
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'bool', value: false},
          },
        ],
      },
      environments: [
        {
          id: 'staging',
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'bool', value: true},
            },
          ],
        },
      ],
      variants: [],
    },
  },
  {
    path: 'segments/example.beta-users.json',
    content: {
      key: 'example.beta-users',
      type: 'segment',
      valueType: 'bool',
      sendToClientSdk: false,
      description: 'Users who opted in to the beta program.',
      default: {
        rules: [
          {
            criteria: [
              {
                operator: 'PROP_IS_ONE_OF',
                propertyName: 'user.beta',
                valueToMatch: {type: 'string_list', value: ['true']},
              },
            ],
            value: {type: 'bool', value: true},
          },
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'bool', value: false},
          },
        ],
      },
      environments: [],
      variants: [],
    },
  },
  {
    path: 'log-levels/example.app.json',
    content: {
      key: 'example.app',
      type: 'log_level',
      valueType: 'log_level',
      sendToClientSdk: false,
      description: 'Application log level.',
      default: {
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'log_level', value: 'INFO'},
          },
        ],
      },
      environments: [],
      variants: [],
    },
  },
]
