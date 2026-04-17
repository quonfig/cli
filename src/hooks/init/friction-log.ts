import {Hook} from '@oclif/core'

import {
  appendFrictionEntry,
  buildFrictionEntry,
  extractLastErrorLine,
  getFrictionLogPath,
  installStderrCapture,
} from '../../util/friction-log.js'

let installed = false

const hook: Hook<'init'> = async function ({config: _config}) {
  if (installed) return
  installed = true

  const logPath = getFrictionLogPath(process.env.QFG_FRICTION_LOG)
  if (!logPath) return

  const readCapturedStderr = installStderrCapture()
  const originalArgv = process.argv.slice(2)

  process.on('exit', (code: number) => {
    if (code === 0) return
    try {
      const entry = buildFrictionEntry({
        argv: originalArgv,
        error: extractLastErrorLine(readCapturedStderr()),
        exitCode: code,
      })
      appendFrictionEntry(logPath, entry)
    } catch {
      // never fail a CLI invocation because of friction logging
    }
  })
}

export default hook
