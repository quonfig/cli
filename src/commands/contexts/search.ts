import {Args, Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {APICommand} from '../../index.js'

interface ContextMatch {
  key: string
  name: null | string
}

export default class ContextsSearch extends APICommand {
  static args = {
    contextType: Args.string({
      description: 'Context type to search, e.g. organization or user (the part before ".key" in a rule)',
      required: true,
    }),
    query: Args.string({
      description: 'Case-insensitive text matched against each context key and its reported properties (e.g. a name)',
      required: true,
    }),
  }

  static description = `Find a context's key from a name, to target it in a rule.

Targeting rules should match a context by its KEY (<contextType>.key, e.g.
organization.key or user.key), not by a slug, email or name. This searches the
contexts your SDKs have reported through telemetry, matching the query against
each context's key and properties, and prints the key and display name of each
match, most recently seen first.

Only contexts your SDKs have reported are searchable. If nothing matches, the key
is unknown: get it from whoever owns that customer rather than targeting a slug
or email instead.

Pass a key as the query to see its display name.`

  static examples = [
    '<%= config.bin %> <%= command.id %> organization formhealth',
    '<%= config.bin %> <%= command.id %> user barry@example.com --environment production',
    '<%= config.bin %> <%= command.id %> organization formhealth --json',
  ]

  static flags = {
    environment: Flags.string({
      description: 'Only contexts reported from this environment (default: every environment)',
    }),
    limit: Flags.integer({
      default: 20,
      description: 'Maximum number of matches (1-100)',
      max: 100,
      min: 1,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(ContextsSearch)

    const request = await this.apiClient.post('/api/v1/contexts/searchKeys', {
      contextType: args.contextType,
      environment: flags.environment,
      limit: flags.limit,
      query: args.query,
      workspaceId: this.workspaceId,
    })

    if (!request.ok) {
      const serverError = request.error as {error?: string; json?: {message?: string}} | undefined
      const errorMsg =
        serverError?.error || serverError?.json?.message || `Failed to search contexts: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const contexts = ((request.json as {contexts?: ContextMatch[]})?.contexts ?? []) as ContextMatch[]

    if (contexts.length === 0) {
      this.log(
        `No context seen via telemetry matched "${args.query}" (type ${args.contextType}), so the key is unknown.\n` +
          'Only contexts your SDKs have reported are searchable. Get the key from whoever owns that ' +
          'customer; do not target a slug or email instead.',
      )
      return {contexts: []}
    }

    const width = Math.max(...contexts.map((c) => c.key.length), 3)
    const lines = [`${'KEY'.padEnd(width)}  NAME`]
    for (const context of contexts) {
      lines.push(`${context.key.padEnd(width)}  ${context.name ?? '(no name reported)'}`)
    }

    lines.push('', `Target these in a rule with propertyName "${args.contextType}.key".`)
    this.log(lines.join('\n'))

    return {contexts} as unknown as JsonObj
  }
}
