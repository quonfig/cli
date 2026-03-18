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
  const request = await command.apiClient.get('/environments/v1')

  if (!request.ok) {
    const errorMsg = request.error?.error || `Failed to fetch environments: ${request.status}`
    return command.err(errorMsg, {serverError: request.error})
  }

  const response = request.json as unknown as ProjectEnvironmentsResponse

  // Filter out deleted environments and sort by name
  return response.environments.filter((env) => !env.deletedAt).sort((a, b) => a.name.localeCompare(b.name))
}
