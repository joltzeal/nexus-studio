import { invalidRequest, UpstreamError } from './errors.js'
import type { StoredScenePlanResult } from './types.js'

export const ENGLISH_OUTPUT =
  'Write every generated text field in English only, including the title, description, observations, explanations, view labels and every image prompt. Translate non-English user requirements into English without dropping constraints. Never switch output language to match the user or the image. Describe non-English printed labels in English instead of quoting them; the original lettering and artwork on the product itself must remain unchanged in the image.'

/** A script guard, not a general language detector: English names may use accents. */
export function hasNonLatinLetters(value: string): boolean {
  return /(?=\p{L})\P{Script_Extensions=Latin}/u.test(value)
}

export function requireEnglishPrompt(value: string): void {
  if (hasNonLatinLetters(value)) {
    throw invalidRequest('生图提示词请使用英文；中文商品要求可先通过智能识图转换')
  }
}

export function requireEnglishOutput(values: readonly string[]): void {
  if (values.some((value) => hasNonLatinLetters(value) || !/[a-z]/i.test(value))) {
    throw new UpstreamError(
      'invalid-response',
      '识图结果必须为英文，请重新识图；未提交后续生图请求',
    )
  }
}

export function sceneResultText(result: StoredScenePlanResult): string[] {
  return [
    result.title ?? '',
    result.description ?? '',
    result.product,
    result.material,
    result.observations,
    result.uncertainties,
    result.reason,
    result.prompt,
    ...(result.translatedRequirements?.trim() ? [result.translatedRequirements] : []),
    ...result.views.flatMap((view) => [view.label, view.prompt]),
  ]
}
