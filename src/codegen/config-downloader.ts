import type {RequestResult} from '../result.js'
import type {ConfigFile} from './types.js'

import {APICommand} from '../index.js'

export class ConfigDownloader {
  constructor(private command: APICommand) {}

  async downloadConfig(): Promise<ConfigFile> {
    try {
      const response = (await this.command.apiClient.get('/all-config-types/v1/download-all-envs')) as RequestResult

      if (!response.ok) {
        throw new Error(`Failed to download config: ${response.status}`)
      }

      // Parse the response data - configs are nested in response.data.json
      const configData = response.json as unknown as ConfigFile

      // Print out each config key
      this.command.verboseLog('\nFound configurations:', configData.configs?.length || 0)

      if (!configData.configs) {
        throw new Error('Invalid response format')
      }

      return configData
    } catch (error) {
      console.error('Error downloading config:', error)
      throw error
    }
  }
}
