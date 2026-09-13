import type { CaseInput, SourceType } from '../types/case'
// 长度限制与后端共用同一份常量，避免前后端提示不一致。
import { CASE_TEXT_MAX_LENGTH, CASE_TEXT_MIN_LENGTH } from '../types/api'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export type TextEncoding = 'auto' | 'utf-8' | 'gb18030'

export function prepareCaseInput(raw: string, sourceType: SourceType): CaseInput {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (!text) throw new Error('案件内容为空，请重新输入或选择文件。')
  // 与后端 createCase 一致：按 Unicode 码点计数，不做非空白过滤，避免同一段文本两端结论不同。
  const charCount = Array.from(text).length
  if (charCount > CASE_TEXT_MAX_LENGTH) throw new Error(`案件文本超过 ${CASE_TEXT_MAX_LENGTH} 个字符，请缩短内容后重新输入。`)
  // Intentional: reject binary control bytes and replacement characters.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/u.test(text)) throw new Error('内容包含乱码或非文本数据，请检查编码并重新输入。')
  if (!/[\p{L}\p{N}]/u.test(text)) throw new Error('内容仅包含符号，请重新输入案件文本。')
  if (charCount < CASE_TEXT_MIN_LENGTH) throw new Error(`案件内容过短，至少需要 ${CASE_TEXT_MIN_LENGTH} 个字符（当前 ${charCount} 个），请补充内容。`)
  return { text, sourceType }
}

export function decodeCaseBytes(bytes: ArrayBuffer, encoding: TextEncoding = 'auto') {
  if (!bytes.byteLength) throw new Error('文件为空，请重新选择 TXT 文件。')
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文件超过 5 MB，请选择更小的 TXT 文件。')
  const candidates = encoding === 'auto' ? ['utf-8', 'gb18030'] as const : [encoding]
  for (const candidate of candidates) {
    try { return { text: new TextDecoder(candidate, { fatal: true }).decode(bytes), encoding: candidate } }
    catch { /* Try another supported encoding; never replace invalid bytes silently. */ }
  }
  throw new Error('无法按 UTF-8 或 GB18030 读取文件，请转换编码后重新选择。')
}

export async function readCaseFile(file: File, encoding: TextEncoding = 'auto') {
  if (!/\.txt$/i.test(file.name)) throw new Error('请选择扩展名为 .txt 的文件。')
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 5 MB，请选择更小的 TXT 文件。')
  if (!file.size) throw new Error('文件为空，请重新选择 TXT 文件。')
  let bytes: ArrayBuffer
  try { bytes = await file.arrayBuffer() } catch { throw new Error('文件读取失败，请重新选择文件或粘贴案件文本。') }
  const decoded = decodeCaseBytes(bytes, encoding)
  return { input: prepareCaseInput(decoded.text, 'txt'), encoding: decoded.encoding }
}
