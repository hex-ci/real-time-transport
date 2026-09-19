import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const webDir = path.resolve(rootDir, 'apps/web')
const serverDir = path.resolve(rootDir, 'apps/server')

const binPath = [
  path.resolve(serverDir, 'node_modules/.bin'),
  path.resolve(webDir, 'node_modules/.bin'),
  path.resolve(rootDir, 'node_modules/.bin'),
  process.env.PATH,
].filter(Boolean).join(':')

const env = { ...process.env, PATH: binPath }

const serverProc = spawn('tsx', ['watch', '--env-file-if-exists=../../.env', 'src/index.ts'], {
  cwd: serverDir,
  env,
  stdio: 'inherit',
})

const webProc = spawn('vite', [], {
  cwd: webDir,
  env,
  stdio: 'inherit',
})

let isShuttingDown = false

function cleanShutdown() {
  if (isShuttingDown) return
  isShuttingDown = true

  const forceTimer = setTimeout(() => {
    try {
      serverProc.kill('SIGKILL')
      webProc.kill('SIGKILL')
    }
    catch {
      // ignore
    }
    process.exit(0)
  }, 1200)

  let remaining = 2
  const onChildExit = () => {
    remaining--
    if (remaining <= 0) {
      clearTimeout(forceTimer)
      process.exit(0)
    }
  }

  serverProc.once('exit', onChildExit)
  webProc.once('exit', onChildExit)
}

process.on('SIGINT', cleanShutdown)
process.on('SIGTERM', cleanShutdown)
