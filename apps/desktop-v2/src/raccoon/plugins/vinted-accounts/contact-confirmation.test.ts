import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountContactChanges } from './contact-confirmation.ts'

const existing = {
  phone: '+14155550100',
  smsOtpUrl: 'https://sms.example/?token=private',
  emailOtpUrl: 'https://mail.example/?token=private',
}
test('contact replacement and clearing require review without exposing inbox URLs', () => {
  const changes = accountContactChanges(existing, {
    phone: '',
    smsOtpUrl: 'https://new.example/?token=new-private',
    emailOtpUrl: '',
  })
  assert.deepEqual(changes, [
    '清空手机号「+14155550100」',
    '替换短信接码链接',
    '清空邮箱接码链接',
  ])
  assert.equal(changes.join('').includes('https://'), false)
  assert.equal(changes.join('').includes('private'), false)
})
test('initial contacts, unchanged values and unrelated edits need no contact review', () => {
  assert.deepEqual(accountContactChanges(null, existing), [])
  assert.deepEqual(
    accountContactChanges({ phone: '', smsOtpUrl: '', emailOtpUrl: '' }, existing),
    [],
  )
  assert.deepEqual(
    accountContactChanges(existing, { ...existing, phone: ` ${existing.phone} ` }),
    [],
  )
})
