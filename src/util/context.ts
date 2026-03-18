interface JavascriptClientContext {
  type: string
  values: {[key: string]: {string: string}}
}

interface JavascriptClientContextInput {
  contexts: JavascriptClientContext[]
}

interface ContextObj {
  [key: string]: {[key: string]: string}
}

export const javaScriptClientFormattedContextToContext = (input: JavascriptClientContextInput): ContextObj => {
  const result: ContextObj = {}

  for (const context of input.contexts) {
    result[context.type] = {}
    for (const [key, value] of Object.entries(context.values)) {
      result[context.type][key] = value.string
    }
  }

  return result
}
