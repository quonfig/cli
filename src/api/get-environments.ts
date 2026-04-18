import type {APICommand} from '../index.js'

export interface Environment {
  active?: boolean
  deletedAt?: number | null
  id: string
  name: string
  protected?: boolean
  type?: string
}

interface ProjectEnvironmentsResponse {
  environments: Environment[]
}

export const getEnvironments = async (command: APICommand): Promise<Environment[]> => {
  const request = await command.apiClient.post('/api/v1/environments/list', {workspaceId: command.workspaceId})

  if (!request.ok) {
    const errorMsg = request.error?.error || `Failed to fetch environments: ${request.status}`
    return command.err(errorMsg, {serverError: request.error})
  }

  // oRPC returns the array directly (not wrapped in { environments: [] })
  const environments = (
    Array.isArray(request.json) ? request.json : (request.json as unknown as ProjectEnvironmentsResponse).environments
  ) as Environment[]

  // Filter out deleted environments and sort by name
  return environments.filter((env) => !env.deletedAt).sort((a, b) => a.name.localeCompare(b.name))
}
