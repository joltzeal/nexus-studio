/**
 * A preset is one ready-made scene sentence plus the shared recovery rule. The
 * reference implementation exposed presentation × environment × camera as three
 * dropdowns, which is more knobs than most listings need; here one choice covers
 * the common cases and the free-text field handles the rest.
 */
export interface ScenePreset {
  id: string
  label: string
  hint: string
  prompt: string
}

const RECOVER =
  'Rebuild the product from the reference image as a clean, complete object: keep its exact shape, material, colours, printed artwork and every readable word, including spelling, case and punctuation. Drop the original background, lighting, shadows and surface glare. Do not invent text that is not legible.'

const QUALITY =
  'Photorealistic photograph, natural perspective and believable scale, no advertising layout, no added slogans or logos.'

export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: 'white-studio',
    label: '纯白棚拍',
    hint: '电商主图，白底、柔和光影',
    prompt: `Place the product on a seamless pure white studio background with soft even lighting and a faint contact shadow. Straight-on view, product centred and filling about 80% of the frame. ${QUALITY}`,
  },
  {
    id: 'grey-studio',
    label: '浅灰棚拍',
    hint: '浅灰渐变背景，保留材质质感',
    prompt: `Place the product against a soft light-grey gradient backdrop with a large diffused key light from the upper left and a subtle shadow. Three-quarter view, product centred. ${QUALITY}`,
  },
  {
    id: 'home-sofa',
    label: '客厅沙发',
    hint: '家居生活场景，自然窗光',
    prompt: `Place the product on or beside a fabric sofa in an ordinary lived-in living room, a cushion and a side table slightly out of focus, soft daylight from a window. Slightly elevated eye-level view. ${QUALITY}`,
  },
  {
    id: 'bedroom-bed',
    label: '卧室床铺',
    hint: '床品场景，暖色柔光',
    prompt: `Place the product on a made bed with a linen duvet in a calm bedroom, warm soft window light from the side, a little everyday clutter at the edge of the frame. Casual handheld angle. ${QUALITY}`,
  },
  {
    id: 'wood-desk',
    label: '木质书桌',
    hint: '桌面平铺，书本与笔做陪衬',
    prompt: `Place the product on an ordinary wooden desk next to a closed book and a pen, daylight from a nearby window, shallow depth of field. Slightly overhead angle. ${QUALITY}`,
  },
  {
    id: 'kitchen-counter',
    label: '厨房台面',
    hint: '台面场景，干净但有生活感',
    prompt: `Place the product on a stone kitchen counter with a cutting board and a mug softly blurred behind it, warm daylight. Eye-level view close to the counter. ${QUALITY}`,
  },
  {
    id: 'wall-hang',
    label: '墙面挂置',
    hint: '挂墙展示，适合画类商品',
    prompt: `Hang the product on a plain painted wall in an ordinary room, a piece of furniture at the edge of the frame, natural window light casting a soft shadow. Straight-on view at hanging height. ${QUALITY}`,
  },
  {
    id: 'store-shelf',
    label: '货架陈列',
    hint: '零售货架，多件商品衬托',
    prompt: `Display the product on a retail shelf among a few similar items that stay out of focus, even store lighting, clean but not staged. Straight-on view. ${QUALITY}`,
  },
  {
    id: 'outdoor-daylight',
    label: '户外自然光',
    hint: '户外桌面或阳台，真实日光',
    prompt: `Place the product on an outdoor table on a bright overcast day, soft shadows, a hint of greenery blurred in the background. Casual handheld angle. ${QUALITY}`,
  },
  {
    id: 'hand-hold',
    label: '手持随拍',
    hint: '手持展示，像二手平台实拍',
    prompt: `Show the product held in one hand against a plain indoor wall, arm and fingers naturally placed, phone-camera framing, soft indoor light. ${QUALITY}`,
  },
]

const PRESET_INDEX = new Map(SCENE_PRESETS.map((preset) => [preset.id, preset]))

export function presetById(id: string): ScenePreset | null {
  return PRESET_INDEX.get(id) ?? null
}

/**
 * `null` preset means the user wrote the whole prompt themselves, so nothing is
 * prepended — the text is sent as typed.
 */
export function composePrompt(presetId: string | null, userPrompt: string): string {
  const extra = userPrompt.trim()
  if (presetId === null) return extra
  const preset = presetById(presetId)
  if (preset === null) return extra
  const parts = [RECOVER, preset.prompt]
  if (extra !== '') parts.push(`Additional requirements: ${extra}`)
  return parts.join(' ').slice(0, 6000)
}

/** Labels are snapshotted onto the record so history survives a preset rename. */
export function presetLabel(presetId: string | null): string | null {
  if (presetId === null) return null
  return presetById(presetId)?.label ?? null
}
