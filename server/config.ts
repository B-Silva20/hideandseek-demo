import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'

const requiredVariables = [
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'DATABASE_URL',
] as const

export type RequiredVariable = (typeof requiredVariables)[number]
export type ConfigurationStatus = {
  ready: boolean
  missing: RequiredVariable[]
  invalid: RequiredVariable[]
}

export function loadEnvironment() {
  // This module is only imported by the backend. Never log dotenv's result.
  dotenv.config({
    path: fileURLToPath(new URL('../.env', import.meta.url)),
    quiet: true,
  })
}

export function getConfigurationStatus(
  environment: NodeJS.ProcessEnv = process.env,
): ConfigurationStatus {
  const missing = requiredVariables.filter((key) => !environment[key]?.trim())
  const invalid: RequiredVariable[] = []
  const baseUrl = environment.LLM_BASE_URL?.trim()

  if (baseUrl) {
    try {
      const parsedUrl = new URL(baseUrl)
      if (
        !['https:', 'http:'].includes(parsedUrl.protocol) ||
        parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash
      ) {
        invalid.push('LLM_BASE_URL')
      }
    } catch {
      invalid.push('LLM_BASE_URL')
    }
  }

  // Only names and booleans may be returned to the browser, never values.
  return { ready: missing.length === 0 && invalid.length === 0, missing, invalid }
}

export function configurationMessage(status: ConfigurationStatus): string {
  if (status.ready) {
    return '后端已启动，必需环境变量已填写；尚未验证模型或数据库连接。'
  }

  const notices: string[] = []
  if (status.missing.length) notices.push(`缺少环境变量：${status.missing.join('、')}`)
  if (status.invalid.length) notices.push(`环境变量格式无效：${status.invalid.join('、')}`)
  return `后端已启动。${notices.join('；')}。请在项目根目录配置 .env 后重启后端。`
}
