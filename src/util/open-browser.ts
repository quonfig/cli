import {spawn} from 'node:child_process'

export const openBrowser = (url: string): void => {
  let command: string
  let args: string[]

  if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '""', url.replaceAll('&', '^&')]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawn(command, args, {detached: true, stdio: 'ignore'})
    child.on('error', () => {
      // Swallow — user can still copy the URL manually.
    })
    child.unref()
  } catch {
    // Swallow — user can still copy the URL manually.
  }
}
