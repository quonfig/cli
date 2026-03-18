import {DefaultBodyType, HttpResponse, StrictRequest} from 'msw'

import type {JsonObj} from '../src/result.js'

export type CannedResponse = [JsonObj, JsonObj, number]
export type CannedResponses = Record<string, CannedResponse[]>

export const ANY = Symbol('any')
export const SECRET_VALUE = (actual: string) => {
  const parts = actual.split('--')

  if (parts.length !== 3) {
    console.error('Expected 3 parts, got', parts)
    return false
  }

  // parts[0] has variable length
  if (parts[0].length < 10) {
    console.error('Expected 10+ chars, got', parts[0])
    return false
  }

  if (parts[1].length !== 24) {
    console.error('Expected 24 chars, got', parts[1])
    return false
  }

  if (parts[2].length !== 32) {
    console.error('Expected 32 chars, got', parts[2])
    return false
  }

  return true
}

const deepCompare = (obj1: unknown, obj2: unknown): boolean => {
  // Check if either of the values is ANY
  //
  // Realistically only the stub should have `ANY` but we don't want to care
  // about argument order.
  if (obj1 === ANY || obj2 === ANY) {
    return true
  }

  if (typeof obj2 === 'function') {
    return obj2(obj1)
  }

  if (typeof obj1 === 'function') {
    return obj1(obj2)
  }

  // If both are the same value/primitive
  if (obj1 === obj2) {
    return true
  }

  // If both are objects (including arrays)
  if (obj1 && obj2 && typeof obj1 === 'object' && typeof obj2 === 'object') {
    const o1 = obj1 as Record<string, unknown>
    // Here obj2 might not be an object, make sure to handle accordingly
    const o2 = obj2 as Record<string, unknown>

    // Check if both are arrays
    if (Array.isArray(o1) && Array.isArray(o2)) {
      if (o1.length !== o2.length) {
        return false
      }

      for (const [i, element] of o1.entries()) {
        if (!deepCompare(element, o2[i])) {
          return false
        }
      }

      return true
    }

    // If both are objects (but not arrays)
    const keys1 = Object.keys(o1)
    const keys2 = Object.keys(o2)

    if (keys1.length !== keys2.length) {
      return false
    }

    for (const key of keys1) {
      if (!keys2.includes(key)) {
        return false
      }

      if (!deepCompare(o1[key], o2[key])) {
        return false
      }
    }

    return true
  }

  // If none of the above, the objects are not equal
  return false
}

export const getCannedResponse = async (
  request: StrictRequest<DefaultBodyType>,
  cannedResponses: CannedResponses,
): Promise<HttpResponse<DefaultBodyType>> => {
  let body: DefaultBodyType = {}

  if (request.method === 'POST') {
    body = await request.json()

    if (!body || typeof body !== 'object') {
      throw new Error('Expected http body to be an object')
    }
  }

  const cannedResponsesForUrl = cannedResponses[request.url]

  if (!cannedResponsesForUrl) {
    console.log(JSON.stringify(body, null, 2))

    throw new Error(`No canned responses for url: ${request.url}`)
  }

  const cannedResponse = cannedResponsesForUrl.find(([payload]) => deepCompare(payload, body))

  if (!cannedResponse) {
    console.log(JSON.stringify(body, null, 2))

    throw new Error(
      `No canned response for method=${request.method} url=${request.url} payload=${JSON.stringify(body, null, 2)}`,
    )
  }

  const [, response, status] = cannedResponse

  return HttpResponse.json(response, {status})
}
