import * as fs from 'node:fs'
import * as path from 'node:path'

interface CreateFileManagerArgs {
  outputDirectory: string
  verboseLog: (category: string | unknown, message?: unknown) => void
}

interface FileManager {
  writeFile: (args: {data: string; filename: string}) => Promise<void>
}

export function createFileManager({outputDirectory, verboseLog}: CreateFileManagerArgs): FileManager {
  return {
    async writeFile({data, filename}): Promise<void> {
      // Ensure the directory exists
      verboseLog(`Creating directory: ${outputDirectory}`)
      await fs.promises.mkdir(outputDirectory, {recursive: true})

      // Write the generated code to the file
      const outputFile = path.join(outputDirectory, filename)
      verboseLog(`Writing file: ${outputFile}`)

      await fs.promises.writeFile(outputFile, data)
      verboseLog(`Wrote file at ${outputFile}`)
    },
  }
}
