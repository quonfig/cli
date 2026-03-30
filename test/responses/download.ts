import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import type {JsonObj} from '../../src/result.js'


const environmentResponse = {
  environments: [
    {id: '588', name: 'test', active: true, protected: false},
    {id: '143', name: 'Production', active: true, protected: false},
  ],
}

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

// GET /environments/v1 - list environments
const environmentsHandler = http.get('https://api.goatsofquonfig.com/environments/v1', () =>
  HttpResponse.json(environmentResponse),
)

// GET /all-config-types/v1/download - download config
const downloadHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/download', ({request}) => {
  const url = new URL(request.url)
  const envId = url.searchParams.get('envId')

  if (envId === '588') {
    return HttpResponse.json(downloadStub)
  }

  return HttpResponse.json({message: 'something went wrong'}, {status: 500})
})

export const server = setupServer(environmentsHandler, downloadHandler)
