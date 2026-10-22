import { invalidRequest } from '../domain/errors.js'
import type { GroupRecord } from '../domain/schemas.js'
import type { StoreDocument } from '../store/private-store.js'

export function listGroups(document: StoreDocument): GroupRecord[] {
  return [...document.groups].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id - right.id,
  )
}

export function requireGroup(document: StoreDocument, groupId: number | null): void {
  if (groupId === null) return
  if (!document.groups.some((group) => group.id === groupId)) {
    throw invalidRequest('代理分组不存在或已删除')
  }
}

/** Reuses an existing group with the same name instead of creating a duplicate. */
export function createGroup(
  document: StoreDocument,
  name: string,
  now: string,
): GroupRecord {
  const existing = document.groups.find((group) => group.name === name)
  if (existing !== undefined) return existing
  const group: GroupRecord = { id: document.nextId++, name, createdAt: now }
  document.groups.push(group)
  return group
}
