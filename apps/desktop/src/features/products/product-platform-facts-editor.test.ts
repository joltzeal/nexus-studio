import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { components, text } from '@/features/settings/kernel-test-support'
import { ProductPlatformFactsEditor } from './product-platform-facts-editor'
import {
  emptyProductForm,
  productSaveInput,
  type ProductVintedFactsForm,
} from './product-form'

function editor(initial: ProductVintedFactsForm[] = []) {
  let value = initial
  const render = (): ReactNode =>
    ProductPlatformFactsEditor({
      value,
      onChange: (next) => {
        value = next
      },
      disabled: false,
    })
  const click = (label: string) => {
    const button = components(render(), Button).find(
      (node) => node.props['aria-label'] === label || text(node.props.children) === label,
    )
    expect(button, `Missing action: ${label}`).toBeDefined()
    button!.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
  }
  const change = (id: string, next: string) => {
    const input = components(render(), Input).find((node) => node.props.id === id)
    expect(input, `Missing field: ${id}`).toBeDefined()
    input!.props.onChange?.({
      target: { value: next },
    } as React.ChangeEvent<HTMLInputElement>)
  }
  return { render, click, change, value: () => value }
}

describe('optional manual Vinted facts editor', () => {
  it('adds explicit catalog and observed attribute inputs without prefilling product facts', () => {
    const t = editor()
    expect(components(t.render(), Input)).toHaveLength(0)
    t.click('添加 Vinted 站点')
    expect(t.value()).toEqual([
      { platformOrigin: '', catalogId: '', catalogRevision: '', attributes: [] },
    ])
    t.change('product-vinted-0-origin', 'https://www.vinted.com')
    t.change('product-vinted-0-catalog-id', '1904')
    t.click('添加已确认属性')
    t.change('product-vinted-0-attribute-0-name', 'Material')
    t.change('product-vinted-0-attribute-0-value', 'Cotton')
    const saved = productSaveInput(
      { ...emptyProductForm(), name: 'Manual product', vintedFacts: t.value() },
      [],
      { createKey: '741204de-e426-4a97-9d1a-a8b420e6eac4' },
    )
    expect(saved.data).toMatchObject({
      category: '',
      brand: '',
      size: '',
      platformFacts: {
        vinted: [
          {
            platformOrigin: 'https://www.vinted.com',
            catalogId: 1904,
            catalogRevision: null,
            attributes: { Material: 'Cotton' },
          },
        ],
      },
    })
    expect(text(t.render())).toContain('网页')
  })

  it('keeps a different market intact when removing an attribute or fallback entry', () => {
    const t = editor([
      {
        platformOrigin: 'https://www.vinted.com',
        catalogId: '1904',
        catalogRevision: '',
        attributes: [{ name: 'Material', value: 'Cotton' }],
      },
      {
        platformOrigin: 'https://www.vinted.co.uk',
        catalogId: '',
        catalogRevision: '',
        attributes: [{ name: 'Size', value: 'M' }],
      },
    ])
    t.click('移除站点 1 的属性 1')
    expect(t.value()[0]!.attributes).toEqual([])
    t.click('移除 Vinted 站点 1')
    expect(t.value()).toEqual([
      {
        platformOrigin: 'https://www.vinted.co.uk',
        catalogId: '',
        catalogRevision: '',
        attributes: [{ name: 'Size', value: 'M' }],
      },
    ])
  })

  it('bounds attribute rows and disables mutation controls during save or upload', () => {
    const value = [
      {
        platformOrigin: 'https://www.vinted.com',
        catalogId: '',
        catalogRevision: '',
        attributes: Array.from({ length: 20 }, (_, index) => ({
          name: `Observed ${index}`,
          value: 'Confirmed',
        })),
      },
    ]
    const tree = ProductPlatformFactsEditor({
      value,
      onChange: () => {},
      disabled: false,
    })
    expect(
      components(tree, Button).find(
        (node) => text(node.props.children) === '添加已确认属性',
      )!.props.disabled,
    ).toBe(true)
    const disabled = ProductPlatformFactsEditor({
      value,
      onChange: () => {},
      disabled: true,
    })
    expect(components(disabled, Input).every((node) => node.props.disabled)).toBe(true)
    expect(components(disabled, Button).every((node) => node.props.disabled)).toBe(true)
  })
})
