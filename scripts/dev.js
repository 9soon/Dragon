'use strict'

const { spawn } = require('child_process')

const isWin = /^win/.test(process.platform)
const npm = isWin ? 'npm.cmd' : 'npm'

const api = spawn(process.execPath, ['server/index.js'], {
  stdio: 'inherit',
  env: process.env
})

const vite = spawn(npm, ['run', 'dev'], {
  stdio: 'inherit',
  shell: isWin,
  env: process.env
})

function shutdown(code) {
  try {
    api.kill()
  } catch (e) {}
  try {
    vite.kill()
  } catch (e) {}
  process.exit(code || 0)
}

api.on('exit', (code) => {
  if (code && code !== 0) shutdown(code)
})
vite.on('exit', (code) => shutdown(code))
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))