import { describe, expect, it } from 'vitest'
import {
  PluginUiViewSchema,
  PluginUiDeclarationSchema,
  PluginUiProfileStatusSchema,
  PluginUiNoticeSchema,
} from './ui.js'

const view = {
  protocolVersion: 1,
  revision: 'revision',
  title: 'Plugin view',
  sections: [
    {
      id: 'details',
      title: 'Details',
      properties: [{ label: 'Name', value: 'Example' }],
    },
  ],
}

describe('generic plugin UI boundary', () => {
  it('validates navigation-only declarations without granting Profile services', () => {
    const icon = { viewBox: '0 0 24 24', paths: ['M1 2h3z'] }
    const navigation = { protocolVersion: 1, navigation: { icon } }
    expect(PluginUiDeclarationSchema.parse(navigation)).toEqual({
      ...navigation,
      services: [],
    })
    for (const paths of [
      ['<script>'],
      ['https://icons.example/test.svg'],
      ['M'.repeat(8193)],
    ]) {
      expect(
        PluginUiDeclarationSchema.safeParse({
          ...navigation,
          navigation: { icon: { ...icon, paths } },
        }).success,
      ).toBe(false)
    }
    expect(PluginUiDeclarationSchema.safeParse({ protocolVersion: 1 }).success).toBe(
      false,
    )
    expect(
      PluginUiDeclarationSchema.safeParse({
        ...navigation,
        services: [
          {
            id: 'mail',
            pluginId: 'studio.mail',
            capability: 'email.provider',
            methods: ['email.messages.get'],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      PluginUiDeclarationSchema.safeParse({
        ...navigation,
        profileTable: {
          title: 'Panel',
          viewId: 'panel',
          capability: 'account.pool',
          icon,
        },
      }).success,
    ).toBe(true)
  })

  it('bounds service declarations and rejects protected or duplicate entries', () => {
    const declaration = {
      protocolVersion: 1,
      profileTable: {
        title: 'Example',
        viewId: 'details',
        capability: 'account.pool',
        icon: { viewBox: '0 0 24 24', paths: ['M1 2h3z'] },
      },
      services: [
        {
          id: 'mail',
          pluginId: 'studio.mail',
          capability: 'email.provider',
          methods: ['email.messages.get'],
        },
      ],
    }
    expect(PluginUiDeclarationSchema.safeParse(declaration).success).toBe(true)
    expect(
      PluginUiDeclarationSchema.safeParse({
        ...declaration,
        services: [...declaration.services, ...declaration.services],
      }).success,
    ).toBe(false)
    expect(
      PluginUiDeclarationSchema.safeParse({
        ...declaration,
        services: [{ ...declaration.services[0], methods: ['ui.view.open'] }],
      }).success,
    ).toBe(false)
    expect(
      PluginUiDeclarationSchema.safeParse({
        ...declaration,
        services: [{ ...declaration.services[0], methods: ['transfer.export'] }],
      }).success,
    ).toBe(false)
  })

  it('accepts semantic icon tones and numeric announcements while rejecting arbitrary presentation code', () => {
    expect(
      PluginUiProfileStatusSchema.safeParse({
        items: [
          {
            profileId: '11111111-1111-4111-8111-111111111111',
            tone: 'success',
            label: 'Normal',
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      PluginUiProfileStatusSchema.safeParse({
        items: [
          {
            profileId: '11111111-1111-4111-8111-111111111111',
            tone: '#ff0000',
            label: 'Normal',
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      PluginUiNoticeSchema.parse({
        id: 'code',
        title: 'Received',
        message: 'Example',
        speech: { channel: 'sms', code: '001234' },
      }).speech?.code,
    ).toBe('001234')
    expect(
      PluginUiNoticeSchema.safeParse({
        id: 'code',
        title: 'Received',
        message: 'Example',
        speech: { channel: 'sms', code: '<script>' },
      }).success,
    ).toBe(false)
  })

  it('requires refresh to reference a declared non-form action', () => {
    expect(
      PluginUiViewSchema.safeParse({
        ...view,
        refresh: { actionId: 'refresh', intervalMs: 5000 },
      }).success,
    ).toBe(false)
    expect(
      PluginUiViewSchema.safeParse({
        ...view,
        actions: [{ id: 'refresh', label: 'Refresh' }],
        refresh: { actionId: 'refresh', intervalMs: 5000 },
      }).success,
    ).toBe(true)
    expect(
      PluginUiViewSchema.safeParse({
        ...view,
        actions: [{ id: 'refresh', label: 'Refresh', submit: true }],
        refresh: { actionId: 'refresh', intervalMs: 5000 },
      }).success,
    ).toBe(false)
  })

  it('rejects executable markup, external schemes and duplicate action identities', () => {
    expect(
      PluginUiViewSchema.safeParse({ ...view, html: '<script>run()</script>' }).success,
    ).toBe(false)
    expect(
      PluginUiViewSchema.safeParse({
        ...view,
        sections: [
          {
            id: 'details',
            title: 'Details',
            properties: [{ label: 'Link', value: 'Open', href: 'javascript:alert(1)' }],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      PluginUiViewSchema.safeParse({
        ...view,
        actions: [
          { id: 'save', label: 'Save' },
          { id: 'save', label: 'Another action' },
        ],
      }).success,
    ).toBe(false)
    expect(PluginUiViewSchema.safeParse({ ...view, protocolVersion: 2 }).success).toBe(
      false,
    )
  })

  it('keeps valid text and supplies bounded component defaults', () => {
    const parsed = PluginUiViewSchema.parse(view)
    expect(parsed.sections[0]?.properties[0]).toEqual({
      label: 'Name',
      value: 'Example',
      copyable: false,
    })
    expect(parsed.actions).toEqual([])
  })

  it('accepts a declared section header action and defaults existing actions to the body', () => {
    const parsed = PluginUiViewSchema.parse({
      ...view,
      sections: [
        {
          ...view.sections[0],
          actions: [
            { id: 'edit', label: 'Edit', placement: 'header' },
            { id: 'open', label: 'Open' },
          ],
        },
      ],
    })
    expect(parsed.sections[0]?.actions.map((action) => action.placement)).toEqual([
      'header',
      'body',
    ])
    expect(
      PluginUiViewSchema.safeParse({
        ...view,
        actions: [{ id: 'edit', label: 'Edit', placement: 'custom-html' }],
      }).success,
    ).toBe(false)
  })
})
