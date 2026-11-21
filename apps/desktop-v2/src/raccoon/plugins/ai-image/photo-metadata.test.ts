import { describe, expect, it } from 'vitest'
import { defaultPhotoMetadata, parsePhotoMetadata } from './photo-metadata'

describe('EXIF 模板输入', () => {
  it('将用户填写的光圈和曝光时间转换为插件参数', () => {
    const parsed = parsePhotoMetadata({
      ...defaultPhotoMetadata(),
      aperture: 'F2.2',
      exposureTime: '1/66 s',
      exposureBias: '0 EV',
      focalLength: '2.2 mm',
    })
    expect(parsed.aperture).toBe(2.2)
    expect(parsed.exposureTime).toBe('1/66')
    expect(parsed.focalLength).toBe(2.2)
  })

  it('阻止无效日期和非数字曝光值，保留表单供用户修改', () => {
    expect(() =>
      parsePhotoMetadata({ ...defaultPhotoMetadata(), modifiedAt: 'today' }),
    ).toThrow('日期')
    expect(() =>
      parsePhotoMetadata({ ...defaultPhotoMetadata(), aperture: 'F0' }),
    ).toThrow('光圈')
  })

  it('拒绝导入的无效下拉值或无效分辨率', () => {
    expect(() =>
      parsePhotoMetadata({ ...defaultPhotoMetadata(), flash: 'fake' as never }),
    ).toThrow('闪光灯')
    expect(() =>
      parsePhotoMetadata({ ...defaultPhotoMetadata(), xResolution: '12.5' }),
    ).toThrow('水平分辨率')
  })
})
