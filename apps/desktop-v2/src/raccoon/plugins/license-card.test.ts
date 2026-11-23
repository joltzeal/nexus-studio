import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePluginCard, validatePluginCard } from './license-card.ts'

test('validates issued plugin card format and accepts case-insensitive input', () => {
  const card = `rac-${'a1'.repeat(8)}`
  assert.equal(validatePluginCard(card), null)
  assert.equal(normalizePluginCard(card), `RAC-${'A1'.repeat(8)}`)
})

test('rejects empty, short, oversized and malformed plugin cards', () => {
  for (const card of ['', '   ', 'RAC-SHORT', `RAC-${'A'.repeat(33)}`, 'RAC-ABC-123456789012']) {
    assert.notEqual(validatePluginCard(card), null, card)
    assert.throws(() => normalizePluginCard(card), /激活码|格式无效/)
  }
})
