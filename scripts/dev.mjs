import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/*
 * Windows/macOS/Linux 通用开发启动器：不依赖 concurrently，不依赖 shell 的 PATH 解析。
 * 使用当前正在运行的 Node 启动 server/client，两者任意一个退出都会停止另一个。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const node = process.execPath
const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')

function start(label, script, args) {
  const child = spawn(node, [script, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  })
  child.on('error', (error) => {
    console.error(`[${label}] 启动失败：${error.message}`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[${label}] 已退出：${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`)
    void shutdown(code || 1)
  })
  return child
}

let shuttingDown = false
const children = [
  start('api', tsx, ['watch', 'server/index.ts']),
  start('web', vite, ['--host', '0.0.0.0']),
]

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill(isWindows ? undefined : 'SIGTERM')
  }
  setTimeout(() => process.exit(code), 500).unref()
}

process.once('SIGINT', () => { void shutdown(0) })
process.once('SIGTERM', () => { void shutdown(0) })
