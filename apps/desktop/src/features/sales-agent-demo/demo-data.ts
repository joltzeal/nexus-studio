export type TaskKind = 'listing' | 'message' | 'inspect'
export type AccountStatus = 'active' | 'blocked'
export type ReviewStatus = 'pending' | 'ready' | 'skip'

export interface DemoWindow {
  id: string
  name: string
  account: string
  provider: string
  status: AccountStatus
  tags: string[]
  rating: string
  available: number
  pending: number
}

export interface ListingFields {
  title: string
  description: string
  price: string
  currency: string
  category: string
  condition: string
  brand: string
  size: string
}

export interface DemoProduct extends ListingFields {
  id: string
  label: string
  kind: 'art' | 'clothing' | 'home'
  collection: string
  coverIndex: 0 | 1 | 2 | 3 | 4 | 5
  imageCount: number
  windowId: string | null
  review: ReviewStatus
  reviewNote: string
  sampleIssue: 'none' | 'copy' | 'image'
}

export const taskPresets: { value: TaskKind; label: string; instruction: string }[] = [
  {
    value: 'listing',
    label: 'Post Listing · 商品上架',
    instruction:
      '检查账号状态，按分配发布商品。保留商品的真实成色和瑕疵；标题与描述使用自然英文。账号封禁时停止该账号的全部任务。',
  },
  {
    value: 'message',
    label: 'Message · 回复消息',
    instruction:
      '检查各账号的未读消息，结合商品资料回复发货与成色问题。不要擅自承诺折扣、退款或站外交易。账号封禁时停止。',
  },
  {
    value: 'inspect',
    label: 'Account Check · 账号检查',
    instruction:
      '检查账号状态、主营品类、评价、可用余额和待结算余额，整理标签，准备写回账号池。账号封禁时停止后续操作。',
  },
]

export const categoryOptions = [
  { value: 'Home / Wall decor', label: '家居 / 墙面装饰' },
  { value: 'Women / Knitwear', label: '女装 / 针织衫' },
  { value: 'Home / Tableware', label: '家居 / 餐具' },
  { value: 'Women / Bags', label: '女装 / 包袋' },
]

export const conditionOptions = [
  { value: 'Very good', label: '成色很好' },
  { value: 'Good', label: '成色良好' },
  { value: 'Satisfactory', label: '有明显使用痕迹' },
  { value: 'New without tags', label: '全新无标签' },
]

export const currencyOptions = [
  { value: 'USD', label: 'USD · $' },
  { value: 'GBP', label: 'GBP · £' },
  { value: 'EUR', label: 'EUR · €' },
]

export const demoWindows: DemoWindow[] = [
  {
    id: 'demo-window-01',
    name: 'US · Home 01',
    account: 'olive.attic',
    provider: 'AdsPower',
    status: 'active',
    tags: ['家居装饰', '复古小物'],
    rating: '4.9 · 86 条评价',
    available: 128.5,
    pending: 42,
  },
  {
    id: 'demo-window-02',
    name: 'US · Closet 02',
    account: 'sunday.closet',
    provider: '比特浏览器',
    status: 'active',
    tags: ['女装', '日常穿搭'],
    rating: '4.8 · 124 条评价',
    available: 76,
    pending: 23.5,
  },
  {
    id: 'demo-window-03',
    name: 'US · Home 03',
    account: 'little.finds',
    provider: '内置浏览器',
    status: 'blocked',
    tags: ['餐具', '家居小物'],
    rating: '4.7 · 32 条评价',
    available: 31,
    pending: 18,
  },
  {
    id: 'demo-window-04',
    name: 'US · Vintage 04',
    account: 'maple.vintage',
    provider: 'AdsPower',
    status: 'active',
    tags: ['复古装饰', '包袋'],
    rating: '5.0 · 47 条评价',
    available: 215,
    pending: 0,
  },
]

export function createDemoWindows(count: 4 | 100): DemoWindow[] {
  return Array.from({ length: count }, (_, index) => {
    const source = demoWindows[index % demoWindows.length]!
    const number = String(index + 1).padStart(2, '0')
    return {
      ...source,
      tags: [...source.tags],
      ...(index < demoWindows.length
        ? {}
        : {
            id: `demo-window-${number}`,
            name: `US · ${index % 2 ? 'Closet' : 'Home'} ${number}`,
            account: `demo.seller.${number}`,
            status: 'active' as const,
          }),
    }
  })
}

export const demoProducts: DemoProduct[] = [
  {
    id: 'demo-product-01',
    label: '复古花卉铁皮画',
    kind: 'art',
    collection: '家居装饰',
    coverIndex: 0,
    imageCount: 3,
    title: 'Vintage floral tin wall sign',
    description:
      'Small floral tin sign from my living room. A few light marks around the edges, shown in the photos. Approx. 20 x 30 cm. Selling as I am changing the room around.',
    price: '18',
    currency: 'USD',
    category: 'Home / Wall decor',
    condition: 'Good',
    brand: 'Unbranded',
    size: '20 x 30 cm',
    windowId: 'demo-window-01',
    review: 'pending',
    reviewNote: '等待检查图片与文案',
    sampleIssue: 'none',
  },
  {
    id: 'demo-product-02',
    label: '米色针织开衫',
    kind: 'clothing',
    collection: '日常衣橱',
    coverIndex: 1,
    imageCount: 4,
    title: 'Elevate your wardrobe with this exquisite cardigan',
    description:
      'Discover the perfect blend of timeless elegance and effortless sophistication. This must-have beige cardigan will elevate every outfit.',
    price: '24',
    currency: 'USD',
    category: 'Women / Knitwear',
    condition: 'Very good',
    brand: 'H&M',
    size: 'M',
    windowId: 'demo-window-02',
    review: 'pending',
    reviewNote: '等待检查图片与文案',
    sampleIssue: 'copy',
  },
  {
    id: 'demo-product-03',
    label: '陶瓷咖啡杯',
    kind: 'home',
    collection: '厨房餐具',
    coverIndex: 2,
    imageCount: 2,
    title: '',
    description: '',
    price: '',
    currency: 'USD',
    category: '',
    condition: '',
    brand: '',
    size: '',
    windowId: 'demo-window-03',
    review: 'pending',
    reviewNote: '资料待补全',
    sampleIssue: 'none',
  },
  {
    id: 'demo-product-04',
    label: '植物帆布画',
    kind: 'art',
    collection: '家居装饰',
    coverIndex: 3,
    imageCount: 3,
    title: 'Framed botanical canvas print',
    description:
      'Botanical print with a light wood frame. It has been on our hallway wall for about a year. Small scuff on one corner. 30 x 40 cm.',
    price: '22',
    currency: 'USD',
    category: 'Home / Wall decor',
    condition: 'Good',
    brand: 'Unbranded',
    size: '30 x 40 cm',
    windowId: 'demo-window-01',
    review: 'pending',
    reviewNote: '等待检查图片与文案',
    sampleIssue: 'image',
  },
  {
    id: 'demo-product-05',
    label: '棕色帆布托特包',
    kind: 'clothing',
    collection: '日常衣橱',
    coverIndex: 4,
    imageCount: 3,
    title: 'Brown canvas tote bag',
    description:
      'Simple canvas tote I used for weekend shopping. Clean inside, with a little wear on the handles. No holes. Approx. 35 x 38 cm.',
    price: '14',
    currency: 'USD',
    category: 'Women / Bags',
    condition: 'Good',
    brand: 'Unbranded',
    size: '35 x 38 cm',
    windowId: null,
    review: 'pending',
    reviewNote: '等待检查图片与文案',
    sampleIssue: 'none',
  },
  {
    id: 'demo-product-06',
    label: '条纹陶瓷小碟',
    kind: 'home',
    collection: '厨房餐具',
    coverIndex: 5,
    imageCount: 2,
    title: 'Small striped ceramic dish',
    description:
      'Little striped dish, useful for keys or jewellery. Bought at a local market. No chips or cracks. About 12 cm across.',
    price: '9',
    currency: 'USD',
    category: 'Home / Tableware',
    condition: 'Very good',
    brand: 'Unbranded',
    size: '12 cm',
    windowId: null,
    review: 'pending',
    reviewNote: '等待检查图片与文案',
    sampleIssue: 'none',
  },
]

export const mugCompletion: ListingFields = {
  title: 'Blue glazed ceramic coffee mug',
  description:
    'Blue ceramic mug from my kitchen. Used occasionally and still in good condition, with no chips or cracks. Holds about 300 ml. Selling a few mugs to make some cupboard space.',
  price: '12',
  currency: 'USD',
  category: 'Home / Tableware',
  condition: 'Good',
  brand: 'Unbranded',
  size: '300 ml',
}

export function formatMoney(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
}
