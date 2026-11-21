import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LabelJob } from '@nexus/plugin-contracts/vinted-helper'
import { LabelExtractor } from './LabelExtractor'
import { HelperTools } from './HelperTools'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

const pdf = new TextEncoder().encode('%PDF-label')
const sha256 = createHash('sha256').update(pdf).digest('hex')
let container: HTMLDivElement
let root: Root
let sessions: Map<string, { filename: string; size: number; marginMm: number }>
let fail: Set<string>

function file(name = 'label.pdf') {
  const item = new File([pdf], name, { type: 'application/pdf' })
  Object.defineProperty(item, 'arrayBuffer', { value: async () => pdf.slice().buffer })
  return item
}

function job(id: string): LabelJob {
  const input = sessions.get(id)!
  return {
    id,
    filename: input.filename,
    inputSize: input.size,
    received: input.size,
    status: 'completed',
    outputSize: pdf.length,
    sha256,
    pageCount: 1,
    notes: [{ page: 1, mode: 'isolated' }],
    error: null,
  }
}

function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label,
  )
  expect(result, `找不到按钮 ${label}`).toBeDefined()
  return result!
}

async function upload(files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    check()
  })
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: webcrypto.subtle,
  })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  sessions = new Map()
  fail = new Set()
  native.invoke.mockReset()
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'plugin_pdf_export') return '/downloads/label-A6.pdf'
    expect(command).toBe('plugin_call')
    const { method, payload } = args.input
    switch (method) {
      case 'vinted.labels.begin': {
        const id = crypto.randomUUID()
        sessions.set(id, payload)
        return { id, chunkSize: 192 * 1024 }
      }
      case 'vinted.labels.append':
        return { received: sessions.get(payload.id)!.size }
      case 'vinted.labels.start':
        if (fail.has(sessions.get(payload.id)!.filename))
          throw { code: 'INVALID_PDF', message: '无法读取 PDF', retryable: false }
        return job(payload.id)
      case 'vinted.labels.read':
        return {
          total: pdf.length,
          next: pdf.length,
          done: true,
          data: Buffer.from(pdf).toString('base64'),
        }
      case 'vinted.labels.close':
        return { closed: true }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<LabelExtractor />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('selecting a PDF immediately extracts and caches a downloadable A6 without a start step', async () => {
  await upload([file()])
  await settle(() =>
    expect(
      native.invoke.mock.calls.some(
        ([, args]) => args?.input?.method === 'vinted.labels.start',
      ),
    ).toBe(true),
  )
  await settle(() => expect(button('下载 A6 面单').disabled).toBe(false))
  expect(container.textContent).not.toContain('待处理')
  expect(container.textContent).not.toContain('开始提取')
  expect(container.querySelector('[role="table"]')).toBeNull()
  expect(
    native.invoke.mock.calls.some(
      ([, args]) => args?.input?.method === 'vinted.labels.read',
    ),
  ).toBe(true)
  expect(
    native.invoke.mock.calls.some(
      ([, args]) => args?.input?.method === 'vinted.labels.close',
    ),
  ).toBe(true)
  const reads = native.invoke.mock.calls.filter(
    ([, args]) => args?.input?.method === 'vinted.labels.read',
  ).length
  await act(async () => button('下载 A6 面单').click())
  expect(native.invoke).toHaveBeenCalledWith('plugin_pdf_export', {
    input: {
      filename: 'label-A6.pdf',
      data: Buffer.from(pdf).toString('base64'),
      sha256,
    },
  })
  expect(
    native.invoke.mock.calls.filter(
      ([, args]) => args?.input?.method === 'vinted.labels.read',
    ),
  ).toHaveLength(reads)
})

it('a bad PDF does not stop the next file and retry uses the current options', async () => {
  fail.add('bad.pdf')
  await upload([file('bad.pdf'), file('good.pdf')])
  await settle(() => expect(button('下载 A6 面单').disabled).toBe(false))
  expect(container.textContent).toContain('无法读取 PDF')
  expect(container.textContent).toContain('good.pdf')
  fail.clear()
  await act(async () => button('选项').click())
  await act(async () => {
    const margin = container.querySelector<HTMLInputElement>('input[type="number"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      margin,
      '5',
    )
    margin.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('按当前设置重新提取').click())
  await settle(() =>
    expect([...container.querySelectorAll('[aria-label="下载 A6 面单"]')]).toHaveLength(
      2,
    ),
  )
  expect([...sessions.values()].at(-1)?.marginMm).toBe(5)
  expect(container.textContent).not.toContain('无法读取 PDF')
})

it('dropping files starts extraction and rejects non-PDF input without creating a session', async () => {
  const drop = container.querySelector('[aria-label="上传面单"]')!
  expect(drop).not.toBeNull()
  await act(async () => {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file()] } })
    drop.dispatchEvent(event)
  })
  await settle(() => expect(button('下载 A6 面单').disabled).toBe(false))
  const previous = sessions.size
  await upload([file('document.txt')])
  expect(sessions.size).toBe(previous)
  expect(container.textContent).toContain('PDF')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
})

it('unmounting during an upload closes a late session and never starts the next file', async () => {
  const transport = native.invoke.getMockImplementation()!
  let finish: (value: unknown) => void = () => {}
  native.invoke.mockImplementation((command, args) => {
    if (args?.input?.method === 'vinted.labels.begin')
      return new Promise((resolve) => {
        finish = resolve
      })
    return transport(command, args)
  })
  await upload([file('first.pdf'), file('second.pdf')])
  await act(async () => root.unmount())
  const id = crypto.randomUUID()
  await act(async () => finish({ id, chunkSize: 192 * 1024 }))
  expect(
    native.invoke.mock.calls.filter(
      ([, args]) => args?.input?.method === 'vinted.labels.begin',
    ),
  ).toHaveLength(1)
  expect(
    native.invoke.mock.calls.some(
      ([, args]) => args?.input?.method === 'vinted.labels.start',
    ),
  ).toBe(false)
  expect(
    native.invoke.mock.calls.some(
      ([, args]) =>
        args?.input?.method === 'vinted.labels.close' && args.input.payload.id === id,
    ),
  ).toBe(true)
  root = createRoot(container)
})

it('cancelling an upload does not leave idle files or start the rest of the batch', async () => {
  const transport = native.invoke.getMockImplementation()!
  let finish: (value: unknown) => void = () => {}
  native.invoke.mockImplementation((command, args) => {
    if (args?.input?.method === 'vinted.labels.begin')
      return new Promise((resolve) => {
        finish = resolve
      })
    return transport(command, args)
  })
  await upload([file('first.pdf'), file('second.pdf')])
  await upload([file('duplicate.pdf')])
  expect(
    native.invoke.mock.calls.filter(
      ([, args]) => args?.input?.method === 'vinted.labels.begin',
    ),
  ).toHaveLength(1)
  await act(async () => button('取消').click())
  const id = crypto.randomUUID()
  await act(async () => finish({ id, chunkSize: 192 * 1024 }))
  expect(
    native.invoke.mock.calls.some(
      ([, args]) => args?.input?.method === 'vinted.labels.start',
    ),
  ).toBe(false)
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2)
  expect(container.textContent).toContain('first.pdf')
  expect(container.textContent).toContain('second.pdf')
  expect(container.textContent).not.toContain('duplicate.pdf')
  expect(container.textContent).not.toContain('待处理')
  expect(button('选择 PDF').disabled).toBe(false)
})

it('never offers a corrupted PDF for download and releases its session', async () => {
  const transport = native.invoke.getMockImplementation()!
  native.invoke.mockImplementation((command, args) => {
    if (args?.input?.method === 'vinted.labels.read')
      return Promise.resolve({
        total: pdf.length,
        next: pdf.length,
        done: true,
        data: Buffer.from('%PDF-wrong').toString('base64'),
      })
    return transport(command, args)
  })
  await upload([file()])
  await settle(() => expect(container.textContent).toContain('面单完整性校验失败'))
  expect(container.querySelector('[aria-label="下载 A6 面单"]')).toBeNull()
  expect(
    native.invoke.mock.calls.some(
      ([, args]) => args?.input?.method === 'vinted.labels.close',
    ),
  ).toBe(true)
})

it('keeps cached downloads across tool switches without extracting again', async () => {
  await act(async () =>
    root.render(
      <HelperTools address={<p>地址工具内容</p>} labels={<LabelExtractor />} />,
    ),
  )
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  await act(async () => tabs[1].click())
  await upload([file()])
  await settle(() => expect(button('下载 A6 面单').disabled).toBe(false))
  const download = button('下载 A6 面单')
  await act(async () => tabs[0].click())
  await act(async () => tabs[1].click())
  expect(button('下载 A6 面单')).toBe(download)
  expect(
    native.invoke.mock.calls.filter(
      ([, args]) => args?.input?.method === 'vinted.labels.start',
    ),
  ).toHaveLength(1)
  await act(async () => download.click())
  expect(
    native.invoke.mock.calls.filter(([command]) => command === 'plugin_pdf_export'),
  ).toHaveLength(1)
})

it('rejects a batch exceeding the file limit before contacting the plugin', async () => {
  await upload(Array.from({ length: 21 }, (_, index) => file(`${index}.pdf`)))
  expect(sessions.size).toBe(0)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('20')
})
