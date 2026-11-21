export interface PhotoMetadata {
  make: string
  model: string
  lensModel: string
  dateTimeOriginal: string
  modifiedAt: string
  aperture: number
  exposureBias: number
  exposureTime: string
  exposureMode: 'auto' | 'manual'
  exposureProgram: 'auto' | 'manual'
  meteringMode: 'multi-segment' | 'center-weighted' | 'spot'
  flash: 'no' | 'no-compulsory' | 'yes'
  focalLength: number
  whiteBalance: 'auto' | 'manual'
  orientation: 1
  xResolution: number
  yResolution: number
  resolutionUnit: 'inch' | 'cm'
  software: string
}

export type PhotoMetadataForm = Omit<
  PhotoMetadata,
  'aperture' | 'exposureBias' | 'focalLength' | 'xResolution' | 'yResolution'
> & {
  aperture: string
  exposureBias: string
  focalLength: string
  xResolution: string
  yResolution: string
}

const STORAGE_KEY = 'raccoon.ai-image.photo-metadata.v1'

function dateTime(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function defaultPhotoMetadata(): PhotoMetadataForm {
  return {
    make: 'Apple',
    model: 'iPhone 17 Pro Max',
    lensModel: 'iPhone 17 Pro Max back triple camera 2.22mm f/2.2',
    dateTimeOriginal: dateTime(),
    modifiedAt: dateTime(),
    aperture: 'F2.2',
    exposureBias: '0 EV',
    exposureTime: '1/66 s',
    exposureMode: 'auto',
    exposureProgram: 'auto',
    meteringMode: 'multi-segment',
    flash: 'no-compulsory',
    focalLength: '2.2 mm',
    whiteBalance: 'auto',
    orientation: 1,
    xResolution: '72',
    yResolution: '72',
    resolutionUnit: 'inch',
    software: '27.0.1',
  }
}

function number(
  value: string,
  label: string,
  suffix: RegExp,
  min: number,
  max: number,
): number {
  const cleaned = value
    .trim()
    .replace(/^F(?=\d)/i, '')
    .replace(suffix, '')
    .trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) throw new Error(`${label}格式无效`)
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error(`${label}超出范围`)
  return parsed
}

function checkDate(value: string): boolean {
  if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false
  const [year, month, day, hour, minute, second] = value.match(/\d+/g)!.map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  )
}

export function parsePhotoMetadata(form: PhotoMetadataForm): PhotoMetadata {
  if (!checkDate(form.dateTimeOriginal) || !checkDate(form.modifiedAt))
    throw new Error('日期格式为 YYYY:MM:DD HH:mm:ss，请检查实际日期')
  const exposureTime = form.exposureTime.trim().replace(/\s*s$/i, '')
  if (
    !/^\d{1,6}\/[1-9]\d{0,6}$/.test(exposureTime) ||
    Number(exposureTime.split('/')[0]) === 0
  )
    throw new Error('曝光时间格式为 1/66 s')
  if (!form.make.trim() || !form.model.trim() || !form.lensModel.trim())
    throw new Error('请填写制造商、型号和镜头型号')
  const allowed = {
    exposureMode: ['auto', 'manual'],
    exposureProgram: ['auto', 'manual'],
    meteringMode: ['multi-segment', 'center-weighted', 'spot'],
    flash: ['no', 'no-compulsory', 'yes'],
    whiteBalance: ['auto', 'manual'],
    resolutionUnit: ['inch', 'cm'],
  } as const
  for (const [key, options] of Object.entries(allowed)) {
    if (!options.includes(form[key as keyof typeof allowed] as never))
      throw new Error(`${key === 'flash' ? '闪光灯' : key}选项无效`)
  }
  if (form.orientation !== 1) throw new Error('图像方向只支持 top, left')
  const xResolution = number(form.xResolution, '水平分辨率', /$/, 1, 1200)
  const yResolution = number(form.yResolution, '垂直分辨率', /$/, 1, 1200)
  if (!Number.isInteger(xResolution) || !Number.isInteger(yResolution))
    throw new Error('水平分辨率和垂直分辨率必须为整数')
  return {
    ...form,
    make: form.make.trim(),
    model: form.model.trim(),
    lensModel: form.lensModel.trim(),
    software: form.software.trim(),
    aperture: number(form.aperture, '光圈', /$/, 0.001, 128),
    exposureBias: number(form.exposureBias, '曝光补偿', /EV$/i, -12, 12),
    exposureTime,
    focalLength: number(form.focalLength, '焦距', /mm$/i, 0.001, 1000),
    xResolution,
    yResolution,
  }
}

export function loadPhotoMetadata(): { enabled: boolean; form: PhotoMetadataForm } {
  const fallback = { enabled: false, form: defaultPhotoMetadata() }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown
    if (typeof saved !== 'object' || saved === null || !('form' in saved)) return fallback
    const form = { ...fallback.form, ...(saved.form as object) }
    parsePhotoMetadata(form)
    return { enabled: 'enabled' in saved && saved.enabled === true, form }
  } catch {
    return fallback
  }
}

export function savePhotoMetadata(enabled: boolean, form: PhotoMetadataForm): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, form }))
}
