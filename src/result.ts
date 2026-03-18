// The goal of the Result approach is to allow writing code like this:
//
//  const result = await doSomething()
//
//  if (result.ok) {
//    // do something with result.value
//    // maybe show the `message` or `json` if they are set
//  } else {
//    this.resultMessage(result)
//  }
//
// The resultMessage method will print the message if the result is a Failure
// but a Noop might not have a message.
//
// If `json` is set and JSON is enabled, it will be preferred to the `message`
export type Result<T> = Failure | Noop | Success<T>

export type JsonObj = Record<string, unknown>

export type Noop = {
  error: false
  json?: JsonObj
  message?: string
  ok: false
}

export type Failure = {
  error: true
  json?: JsonObj
  message: string
  ok: false
}

export type Success<T> = {
  error: false
  json?: JsonObj
  message?: string
  ok: true
  value: T
}

export const noop = (message?: string): Noop => ({error: false, message, ok: false})

export const failure = (message: string, json?: JsonObj): Failure => ({error: true, json, message, ok: false})

export const success = <T>(value: T, message?: string, json?: JsonObj): Success<T> => ({
  error: false,
  json,
  message,
  ok: true,
  value,
})

export type RequestSuccess = {
  json: JsonObj
  ok: true
  status: number
}

export type RequestFailure = {
  error: JsonObj
  ok: false
  status: number
}

export type RequestResult = RequestFailure | RequestSuccess
