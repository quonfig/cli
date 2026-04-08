import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import type {JsonObj} from '../../src/result.js'


export const downloadStub: JsonObj = {
  configs: [
    {
      changedBy: {sdkKeyId: '', email: 'jdwyer@quonfig.com', userId: '0'},
      configType: 'CONFIG',
      draftid: '2',
      id: '16777738077090689',
      key: 'intprop',
      projectId: '2',
      rows: [{values: [{value: {int: '3'}}]}],
      valueType: 'NOT_SET_VALUE_TYPE',
    },
  ],
}

// POST /api/v1/environments/list - list environments (oRPC wrapped)
const environmentsHandler = http.post('https://app.quonfig.com/api/v1/environments/list', () =>
  HttpResponse.json({
    json: [
      {id: '588', name: 'test', active: true, protected: false},
      {id: '143', name: 'Production', active: true, protected: false},
    ],
  }),
)

// GET /all-config-types/v1/download - download config (OAuth path, not oRPC)
const downloadHandler = http.get('https://app.quonfig.com/all-config-types/v1/download', ({request}) => {
  const url = new URL(request.url)
  const envId = url.searchParams.get('envId')

  if (envId === '588') {
    return HttpResponse.json(downloadStub)
  }

  return HttpResponse.json({message: 'something went wrong'}, {status: 500})
})

export const server = setupServer(environmentsHandler, downloadHandler)
