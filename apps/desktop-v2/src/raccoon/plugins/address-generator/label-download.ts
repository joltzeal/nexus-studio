import { invoke } from '@tauri-apps/api/core'
import { LABEL_MAX_OUTPUT_BYTES } from '@nexus/plugin-contracts/vinted-helper'

type ExportInput = { filename: string; data: string; sha256: string }
export async function saveLabelPdf(
  name: string,
  bytes: Uint8Array,
  sha256: string,
  save: (input: ExportInput) => Promise<unknown> = (input) =>
    invoke('plugin_pdf_export', { input }),
): Promise<string | null> {
  if (
    !bytes.length ||
    bytes.length > LABEL_MAX_OUTPUT_BYTES ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error('PDF 保存参数无效')
  const filename =
    name
      .replace(/\.pdf$/i, '')
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
      .slice(0, 230)
      .replace(/[\uD800-\uDBFF]$/, '') + '-A6.pdf'
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  let path: unknown
  try {
    path = await save({ filename, data: btoa(binary), sha256 })
  } catch (cause) {
    throw new Error(
      typeof cause === 'string' && cause.length < 500 ? cause : 'PDF 保存失败，请重试',
    )
  }
  if (path !== null && (typeof path !== 'string' || !path.length || path.length > 4096))
    throw new Error('PDF 保存结果无效')
  return path as string | null
}
