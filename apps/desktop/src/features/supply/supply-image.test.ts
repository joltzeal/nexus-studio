import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ProductGrid } from './product-grid'
import type { Product } from './types'

it('does not hand CDN URLs to WebView img elements when rendering the product grid', () => {
  const product: Product = {
    id: '1',
    title: 'photo',
    description: '',
    price: '',
    merchantId: '1',
    images: ['https://product.aliyizhan.com/person/a.jpg'],
    coverUrl: 'https://product.aliyizhan.com/person/a.jpg',
    publishedAt: null,
    raw: {},
  }
  const html = renderToStaticMarkup(
    createElement(ProductGrid, {
      rows: [product],
      view: 'waterfall',
      onOpen: () => undefined,
    }),
  )
  expect(html).not.toMatch(/<img[^>]+src="https?:/)
  expect(html).toContain('图片加载中')
})
