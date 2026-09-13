import { createApp } from './app.js'
import { configurationMessage, getConfigurationStatus, loadEnvironment } from './config.js'

loadEnvironment()
const configuration = getConfigurationStatus()
const notice = configurationMessage(configuration)
if (configuration.ready) {
  console.info(`[配置] ${notice}`)
} else {
  console.warn(`[配置] ${notice}`)
}

const server = createApp().listen(3001, '127.0.0.1', () => {
  console.info('[API] http://127.0.0.1:3001/api/health')
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE'
    ? '[API] 端口 3001 已被占用，请关闭占用该端口的进程后重新启动。'
    : '[API] 启动失败，请检查本地网络和端口设置。')
  process.exitCode = 1
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
