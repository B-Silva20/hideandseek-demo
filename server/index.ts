import { createApp } from './app.js'
import { configurationMessage, getConfigurationStatus, loadEnvironment } from './config.js'
import { flushPersistenceSync, startPersistence } from './services/persistence.js'

loadEnvironment()
const configuration = getConfigurationStatus()
const notice = configurationMessage(configuration)
if (configuration.ready) {
  console.info(`[配置] ${notice}`)
} else {
  console.warn(`[配置] ${notice}`)
}

// 先恢复上一次的存档再开始接受请求：这样启动后第一份 GET /api/saves 就是完整的。
try {
  const persistence = await startPersistence()
  const restored = persistence.restoredCases || persistence.restoredSessions
    ? `，已恢复 ${persistence.restoredCases} 个案件、${persistence.restoredSessions} 局审讯`
    : ''
  console.info(`[存档] ${persistence.file}${restored}`)
  if (persistence.issue) console.warn(`[存档] ${persistence.issue}`)
  if (!persistence.active) console.warn('[存档] 检测到更新版本的存档，本次运行不会覆盖它。')
} catch {
  console.warn('[存档] 读取存档失败，本次以空存档启动。')
}

const host = process.env.APP_HOST?.trim() || '127.0.0.1'
const port = Number.parseInt(process.env.APP_PORT?.trim() || '3001', 10) || 3001
const server = createApp().listen(port, host, () => {
  console.info(`[API] http://${host}:${port}/api/health`)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE'
    ? `[API] 端口 ${port} 已被占用，请关闭占用该端口的进程后重新启动。`
    : '[API] 启动失败，请检查本地网络和端口设置。')
  process.exitCode = 1
})

function shutdown() {
  // 退出前同步落盘：节流中的自动存档还排在定时器里，等不到下一次写入。
  try {
    flushPersistenceSync()
  } catch {
    console.warn('[存档] 退出前写入存档失败，最后一段进度可能没有保存。')
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
