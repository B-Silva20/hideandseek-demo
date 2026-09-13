import { Router } from 'express'
import { readFile } from 'node:fs/promises'

const presetPath = new URL('../../tests/fixtures/private/占星术杀人魔法.txt', import.meta.url)
export function createPresetRouter() {
  const router = Router()
  router.get('/cases/preset', async (_request, response) => {
    try {
      const bytes = await readFile(presetPath)
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
        response.status(422).json({ error: '预置案件为空或超过 5 MB，请使用其他输入方式。' })
        return
      }
      response.setHeader('Cache-Control', 'no-store')
      response.type('application/octet-stream').send(bytes)
    } catch {
      response.status(404).json({ error: '预置案件文件不可用，请粘贴文本或上传 TXT 文件。' })
    }
  })
  return router
}
