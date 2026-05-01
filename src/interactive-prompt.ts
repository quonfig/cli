import {Config} from '@oclif/core/lib/interfaces/index.js'

import Create from './commands/create.js'
import GenerateNewHexKey from './commands/generate-new-hex-key.js'
import Get from './commands/get.js'
import Info from './commands/info.js'
import List from './commands/list.js'
import Override from './commands/override.js'
import SetDefault from './commands/set-default.js'
import {APICommand} from './index.js'
import getString from './ui/get-string.js'
import autocomplete from './util/autocomplete.js'
import {green} from './util/color.js'

const convertToKebabCase = (text: string) =>
  text
    .replaceAll(/([A-Z])/g, ' $1')
    .trim()
    .replaceAll(' ', '-')
    .toLowerCase()

type SuggestedCommand = {
  command:
    | typeof Create
    | typeof GenerateNewHexKey
    | typeof Get
    | typeof Info
    | typeof List
    | typeof Override
    | typeof SetDefault
  description: string
  displayCommandName: string
  id: string
  implicitFlags: string[]
}

const commands: SuggestedCommand[] = [SetDefault, GenerateNewHexKey, Create, Get, Info, Override, List].map(
  (command): SuggestedCommand => {
    const id = convertToKebabCase(command.name)
    return {
      command,
      description: command.description,
      displayCommandName: id,
      id,
      implicitFlags: [],
    }
  },
)

commands.push(
  {
    command: SetDefault,
    description: 'Set/update the default value for an environment to an ENV Var',
    displayCommandName: 'set-default --env-var',
    id: 'set-default',
    implicitFlags: ['env-var'],
  },
  {
    command: SetDefault,
    description: 'Set/update the default value for an environment with --secret',
    displayCommandName: 'set-default --secret',
    id: 'set-default',
    implicitFlags: ['secret'],
  },
  {
    command: Create,
    description: 'Create a new item in Quonfig with --secret',
    displayCommandName: 'create --secret',
    id: 'create',
    implicitFlags: ['secret'],
  },
  {
    command: Create,
    description: 'Create an ENV Var provided item in Quonfig with --env-var',
    displayCommandName: 'create --env-var',
    id: 'create',
    implicitFlags: ['env-var'],
  },
)

type AvailableCommand = (typeof commands)[number]

const descriptions: Record<string, string> = {}

for (const command of commands) {
  descriptions[command.displayCommandName] = command.description.split('\n')[0]
}

type Arg = {
  description?: string
  options?: string[]
  required: boolean
  type: string
}

const isAPICommand = (command: SuggestedCommand['command']): boolean =>
  // Check if command extends APICommand by checking prototype chain
  command.prototype instanceof APICommand

const promptForInput = async (arg: Arg, name: string, commandId: string, command: SuggestedCommand['command']) => {
  let value

  const message = arg.description ?? name

  if (arg.options) {
    value = await autocomplete({message, source: arg.options})
  } else {
    switch (arg.type) {
      case 'option': {
        // APICommand-based commands handle their own "name" arg prompting with autocomplete from metadata API
        // Skip prompting here for those commands (except create which needs the name upfront)
        if (name === 'name' && commandId !== 'create' && isAPICommand(command)) {
          // Skip prompting - let the OAuth command handle it interactively
          value = undefined
        } else {
          value = await getString({allowBlank: false, message})
        }

        break
      }

      default: {
        throw new Error(`Unknown arg type: ${arg.type}`)
      }
    }
  }

  if (!value && name !== 'name') {
    throw new Error(`Missing required argument: ${name}`)
  }

  return value
}

const getArgs = async (
  args: AvailableCommand['command']['args'],
  commandId: string,
  command: SuggestedCommand['command'],
): Promise<string[]> => {
  const requiredArgs = Object.keys(args)

  const values = await Promise.all(
    Object.entries(args)
      .filter(([key]) => requiredArgs.includes(key))
      .map(([key, arg]) => promptForInput(arg, key, commandId, command)),
  )

  // Filter out undefined values (OAuth commands handle their own name prompting)
  return values.filter((v): v is string => v !== undefined)
}

const getFlags = async (
  flags: AvailableCommand['command']['flags'],
  commandId: string,
  implicitFlags: string[],
  command: SuggestedCommand['command'],
): Promise<string[]> => {
  if (!flags && implicitFlags.length === 0) {
    return []
  }

  const inputs: string[] = []
  const promiseInputs: Promise<void>[] = []

  for (const [key, arg] of Object.entries(flags)) {
    if (arg.required || implicitFlags.includes(key)) {
      if (arg.type === 'boolean') {
        inputs.push(`--${key}`)
      } else {
        // eslint-disable-next-line no-await-in-loop
        const value = await promptForInput(arg, key, commandId, command)
        inputs.push(`--${key}=${value}`)
      }
    }
  }

  await Promise.all(promiseInputs)

  return inputs
}

export const interactivePrompt = async (config: Config) => {
  const longestCommandId = commands
    .map((c) => c.displayCommandName.length)
    .sort((a, b) => a - b)
    .reverse()[0]

  const namesAndDescriptions = commands
    .map((command) => ({
      description: `${command.displayCommandName}${' '.repeat(
        longestCommandId - command.displayCommandName.length + 4,
      )} ${descriptions[command.displayCommandName]}`.replaceAll('the provided', 'a'),
      id: command.displayCommandName,
    }))
    .sort((a, b) => a.description.localeCompare(b.description))

  const selectedChoice = await autocomplete({
    message: green('What would you like to do?'),
    source: namesAndDescriptions.map((c) => c.description),
  })

  const selectedCommandId = namesAndDescriptions.find((c) => c.description === selectedChoice)?.id

  if (selectedCommandId) {
    const chosenCommand = commands.find((c) => c.displayCommandName === selectedCommandId)

    if (!chosenCommand) {
      return
    }

    const cliArgs = process.argv.slice(2)

    const args = await getArgs(chosenCommand.command.args, chosenCommand.id, chosenCommand.command)
    const flags = await getFlags(
      chosenCommand.command.flags,
      chosenCommand.id,
      chosenCommand.implicitFlags,
      chosenCommand.command,
    )

    const allArgs = [...cliArgs, ...args, ...flags]

    if (process.env.VERBOSE) {
      allArgs.push('--verbose')
    }

    await config.runCommand(chosenCommand.id, allArgs)
  }
}
