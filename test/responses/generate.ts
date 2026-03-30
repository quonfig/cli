import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'


// GET /all-config-types/v1/download-all-envs - download all configs
const downloadAllEnvsHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/download-all-envs', () =>
  HttpResponse.json({
    configs: [
      {
        key: 'test.config',
        type: 'config',
        valueType: 'string',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'string',
                value: 'test-value',
              },
            },
          ],
        },
      },
      {
        key: 'test.flag',
        type: 'feature_flag',
        valueType: 'bool',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'bool',
                value: false,
              },
            },
          ],
        },
      },
    ],
  }),
)

export const server = setupServer(downloadAllEnvsHandler)
