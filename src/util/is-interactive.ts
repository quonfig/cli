type Flags = {
  interactive?: boolean
}

const isInteractive = (flags: Flags) => {
  if (flags.interactive === false) {
    return false
  }

  return (process.stdout.isTTY && process.stdin.isTTY) || flags.interactive
}

export default isInteractive
