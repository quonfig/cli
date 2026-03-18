import {Flags} from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {JsonObj} from '../result.js'

import {APICommand} from '../index.js'
import {getProjectEnvFromSdkKey} from '../quonfig-common/src/getProjectEnvFromSdkKey.js'
import getEnvironment from '../ui/get-environment.js'
import {checkmark} from '../util/color.js'
import getClient from '../util/get-client.js'

export default class Download extends APICommand {
  static description = `Download a Datafile for a given environment

  You can serve a datafile using the \`serve\` command.`

  static examples = [
    '<%= config.bin %> <%= command.id %> --environment=test',
    '<%= config.bin %> <%= command.id %> --environment=test --sdk-key=YOUR_SDK_KEY',
  ]

  static flags = {
    environment: Flags.string({description: 'environment to download'}),
    'sdk-key': Flags.string({
      description: 'SDK key for authentication (uses legacy download endpoint)',
      required: false,
    }),
  }

  public async init(): Promise<void> {
    await super.init()

    const {flags} = await this.parse(Download)

    // If SDK key is provided, reinitialize the client with it
    if (flags['sdk-key']) {
      this.rawApiClient = await getClient(this, flags['sdk-key'], flags.profile)
      this.currentEnvironment = getProjectEnvFromSdkKey(flags['sdk-key'])
    }
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Download)

    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to download?',
      providedEnvironment: flags.environment,
    })

    if (!environment) {
      return
    }

    this.verboseLog({environment, usingSdkKey: Boolean(flags['sdk-key'])})

    // Use legacy endpoint if SDK key is provided, otherwise use new OAuth endpoint
    const downloadUrl = flags['sdk-key']
      ? `/api/v2/configs/download?envId=${environment.id}`
      : `/all-config-types/v1/download?envId=${environment.id}`

    const download = await this.apiClient.get(downloadUrl)

    if (download.ok) {
      return this.writeFile(download, environment)
    }

    this.verboseLog({result: download})
    return this.err(`Failed to download file. Status=${download.status}`, download.error)
  }

  private writeFile(result: JsonObj, environment: {id: string; name: string}) {
    const fileName = `quonfig.${environment.name}.${environment.id}.config.json`
    const filePath = path.join(process.cwd(), fileName)

    fs.writeFileSync(filePath, JSON.stringify(result.json, null, 2))

    this.log(`${checkmark} Successfully downloaded ${fileName}`)
    return {filePath, succes: true}
  }
}
