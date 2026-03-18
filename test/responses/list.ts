import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {identityHandler, identityHandlerTestDomain} from '../test-auth-helper.js'

/**
 * Mock responses for list command tests
 * Uses v1 API endpoints
 */

// GET /all-config-types/v1/metadata - list all configs
const metadataHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/metadata', () =>
  HttpResponse.json({
    configs: [
      {
        key: 'feature-flag.integer',
        type: 'feature_flag',
        valueType: 'int',
        version: 1,
        id: 1,
        name: 'Integer Feature Flag',
        description: 'A feature flag with int value',
      },
      {
        key: 'log-level.reforge.views.index',
        type: 'log_level',
        valueType: 'log_level',
        version: 1,
        id: 2,
        name: 'Index View Log Level',
        description: 'Log level for index view',
      },
      {
        key: 'segment-with-and-conditions',
        type: 'segment',
        valueType: 'string',
        version: 1,
        id: 3,
        name: 'Segment with AND conditions',
        description: 'A segment for testing',
      },
      {
        key: 'my-string-list-key',
        type: 'config',
        valueType: 'string_list',
        version: 1,
        id: 4,
        name: 'My String List',
        description: 'A string list config',
      },
    ],
  }),
)

export const server = setupServer(identityHandler, identityHandlerTestDomain, metadataHandler)
