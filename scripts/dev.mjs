import { spawn } from 'node:child_process'

const processes = [
  spawn(process.execPath, ['--watch', 'server/index.js'], {
    env: process.env,
    stdio: 'inherit',
  }),
  spawn('npx', ['vite', '--host', '127.0.0.1'], {
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  }),
]

let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of processes) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}

for (const child of processes) {
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) shutdown(code ?? 1)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
