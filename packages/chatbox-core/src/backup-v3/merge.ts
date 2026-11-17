import { collectMessageReferences, type ResourceReference } from '../resources'
import type { MessageRow, ThreadRow } from '../session/session-tree/types'
import { tombstoneCovers, type SyncTombstone } from './tombstones'

export interface ConversationMerge {
  removedSession: boolean
  changed: boolean
  messages: MessageRow[]
  threads: ThreadRow[]
  resourceKeys: string[]
}

function cloneMessage(message: MessageRow): MessageRow {
  return { ...message, message: message.message }
}

function cloneThread(thread: ThreadRow): ThreadRow {
  return { ...thread, compactionPoints: [...thread.compactionPoints] }
}

function newest(
  tombstones: readonly SyncTombstone[],
  kind: SyncTombstone['kind'],
  sessionId: string,
  objectId: string,
) {
  let deletedAt: number | null = null
  for (const tombstone of tombstones) {
    if (tombstone.kind !== kind || tombstone.sessionId !== sessionId || tombstone.objectId !== objectId) continue
    if (deletedAt === null || tombstone.deletedAt > deletedAt) deletedAt = tombstone.deletedAt
  }
  return deletedAt
}

function isDescendant(tip: string, ancestor: string, parents: ReadonlyMap<string, string | null>): boolean {
  let current: string | null = tip
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = parents.get(current) ?? null
  }
  return false
}

function walkLeaf(root: string | null, messages: ReadonlyMap<string, MessageRow>): string | null {
  let current = root
  const seen = new Set<string>()
  while (current && messages.has(current) && !seen.has(current)) {
    seen.add(current)
    const next = messages.get(current)?.activeChildId ?? null
    if (!next || !messages.has(next)) return current
    current = next
  }
  return current && messages.has(current) ? current : null
}

function pointStillExists(
  point: ThreadRow['compactionPoints'][number],
  messages: ReadonlyMap<string, MessageRow>,
): boolean {
  return messages.has(point.boundaryMessageId) && messages.get(point.summaryMessageId)?.kind === 'summary'
}

function assignThreadOrders(threads: Map<string, ThreadRow>, preferredActiveId: string | undefined) {
  const list = [...threads.values()]
  if (!list.length) return
  const active =
    list.find((thread) => thread.threadId === preferredActiveId) ??
    list.find((thread) => thread.threadOrder === -1) ??
    list[0]
  if (!active) return
  active.threadOrder = -1
  const used = new Set<number>([-1])
  for (const thread of list) {
    if (thread === active) continue
    if (thread.threadOrder < 0 || used.has(thread.threadOrder)) {
      let order = 0
      while (used.has(order)) order += 1
      thread.threadOrder = order
    }
    if (thread.name === null) thread.name = 'Thread'
    used.add(thread.threadOrder)
  }
}

function repairThread(thread: ThreadRow, messages: Map<string, MessageRow>) {
  const inThread = [...messages.values()].filter((message) => message.threadId === thread.threadId)
  if (!inThread.length) {
    thread.rootMessageId = null
    thread.activeLeafMessageId = null
    thread.compactionPoints = []
    return
  }
  for (const message of inThread) {
    if (message.parentMessageId && !messages.has(message.parentMessageId)) message.parentMessageId = null
  }
  const roots = inThread.filter((message) => message.parentMessageId === null)
  const root =
    roots.find((message) => message.messageId === thread.rootMessageId) ??
    roots.sort((left, right) => left.siblingOrder - right.siblingOrder || left.createdAt - right.createdAt)[0]
  if (!root) return
  for (const extra of roots) {
    if (extra !== root) extra.parentMessageId = root.messageId
  }
  const groups = new Map<string, MessageRow[]>()
  for (const message of inThread) {
    const key = message.parentMessageId ?? ''
    groups.set(key, [...(groups.get(key) ?? []), message])
  }
  for (const group of groups.values()) {
    if (new Set(group.map((message) => message.siblingOrder)).size === group.length) continue
    group.sort(
      (left, right) =>
        left.siblingOrder - right.siblingOrder ||
        left.createdAt - right.createdAt ||
        left.messageId.localeCompare(right.messageId),
    )
    group.forEach((message, index) => {
      message.siblingOrder = index
    })
  }
  for (const message of inThread) {
    const children = inThread.filter((child) => child.parentMessageId === message.messageId)
    if (message.activeChildId && !children.some((child) => child.messageId === message.activeChildId))
      message.activeChildId = null
    if (message.activeChildId) {
      message.pendingBranchId = undefined
      message.pendingBranchOrder = undefined
    } else if (
      message.pendingBranchOrder !== undefined &&
      children.some((child) => child.siblingOrder === message.pendingBranchOrder)
    ) {
      message.pendingBranchId = undefined
      message.pendingBranchOrder = undefined
    }
  }
  thread.rootMessageId = root.messageId
  thread.activeLeafMessageId = walkLeaf(root.messageId, messages)
  thread.compactionPoints = thread.compactionPoints.filter((point) => pointStillExists(point, messages))
}

function resourceKeys(messages: readonly MessageRow[]): string[] {
  const references: ResourceReference[] = []
  for (const message of messages) collectMessageReferences(message.message, message.sessionId, references)
  return [...new Set(references.map((reference) => reference.storageKey))]
}

/**
 * Unions one conversation by message id. A tombstone removes an object only when
 * the object is not newer than the deletion. Missing objects without a tombstone stay.
 */
export function mergeConversation(input: {
  sessionId: string
  localMessages: readonly MessageRow[]
  remoteMessages: readonly MessageRow[]
  localThreads: readonly ThreadRow[]
  remoteThreads: readonly ThreadRow[]
  tombstones: readonly SyncTombstone[]
}): ConversationMerge {
  const sessionId = input.sessionId
  const sessionDeletedAt = newest(input.tombstones, 'session', sessionId, sessionId)
  const localIds = new Set(input.localMessages.map((message) => message.messageId))
  const messages = new Map<string, MessageRow>()
  for (const message of input.localMessages) messages.set(message.messageId, cloneMessage(message))
  const takenFromRemote: MessageRow[] = []
  for (const remote of input.remoteMessages) {
    const local = messages.get(remote.messageId)
    if (!local) {
      const copy = cloneMessage(remote)
      messages.set(remote.messageId, copy)
      takenFromRemote.push(copy)
      continue
    }
    if (remote.updatedAt > local.updatedAt) {
      const copy = cloneMessage(remote)
      messages.set(remote.messageId, copy)
      takenFromRemote.push(copy)
    }
  }

  const covered = (message: MessageRow) => {
    const messageDeletedAt = newest(input.tombstones, 'message', sessionId, message.messageId)
    const threadDeletedAt = newest(input.tombstones, 'thread', sessionId, message.threadId)
    return (
      (sessionDeletedAt !== null && tombstoneCovers(sessionDeletedAt, message.updatedAt)) ||
      (messageDeletedAt !== null && tombstoneCovers(messageDeletedAt, message.updatedAt)) ||
      (threadDeletedAt !== null && tombstoneCovers(threadDeletedAt, message.updatedAt))
    )
  }
  let removing = true
  while (removing) {
    removing = false
    for (const [id, message] of [...messages]) {
      if (!covered(message)) continue
      for (const child of [...messages.values()]) {
        if (child.parentMessageId === id) child.parentMessageId = message.parentMessageId
      }
      const parent = message.parentMessageId ? messages.get(message.parentMessageId) : undefined
      if (parent?.activeChildId === id) {
        parent.activeChildId = null
        parent.pendingBranchId = undefined
        parent.pendingBranchOrder = undefined
      }
      messages.delete(id)
      removing = true
    }
  }

  const threads = new Map<string, ThreadRow>()
  for (const thread of input.localThreads) threads.set(thread.threadId, cloneThread(thread))
  let archivedOrder = Math.max(0, ...[...threads.values()].map((thread) => thread.threadOrder))
  const localActive = [...threads.values()].find((thread) => thread.threadOrder === -1)
  for (const remote of input.remoteThreads) {
    if (threads.has(remote.threadId)) continue
    const copy = cloneThread(remote)
    if (copy.threadOrder === -1 && localActive) {
      archivedOrder += 1
      copy.threadOrder = archivedOrder
      copy.name = copy.name ?? 'Thread'
    }
    threads.set(remote.threadId, copy)
  }
  for (const [id, thread] of threads) {
    const threadDeletedAt = newest(input.tombstones, 'thread', sessionId, id)
    const alive = [...messages.values()].some(
      (message) => message.threadId === id && (threadDeletedAt === null || message.updatedAt > threadDeletedAt),
    )
    const sessionCoversThread =
      sessionDeletedAt !== null &&
      ![...messages.values()].some((message) => message.threadId === id && message.updatedAt > sessionDeletedAt)
    if ((threadDeletedAt !== null && !alive) || sessionCoversThread) threads.delete(id)
  }
  for (const [id, message] of messages) if (!threads.has(message.threadId)) messages.delete(id)
  assignThreadOrders(threads, input.localThreads.find((thread) => thread.threadOrder === -1)?.threadId)

  const remoteChild = new Map(input.remoteMessages.map((message) => [message.messageId, message.activeChildId]))
  for (const thread of input.localThreads) {
    const leafId = thread.activeLeafMessageId
    if (!leafId) continue
    const leaf = messages.get(leafId)
    if (!leaf || leaf.activeChildId) continue
    const children = [...messages.values()].filter((message) => message.parentMessageId === leafId)
    const preferred = remoteChild.get(leafId)
    if (preferred && children.some((message) => message.messageId === preferred)) leaf.activeChildId = preferred
    else if (children.length === 1) leaf.activeChildId = children[0]?.messageId ?? null
    if (leaf.activeChildId) {
      leaf.pendingBranchId = undefined
      leaf.pendingBranchOrder = undefined
    }
  }

  for (const thread of threads.values()) {
    const previous = input.localThreads.find((item) => item.threadId === thread.threadId)
    const previousLeaf = previous?.activeLeafMessageId ?? null
    const remote = input.remoteThreads.find((item) => item.threadId === thread.threadId)
    repairThread(thread, messages)
    const parents = new Map([...messages.values()].map((message) => [message.messageId, message.parentMessageId]))
    if (
      previousLeaf &&
      thread.activeLeafMessageId &&
      thread.activeLeafMessageId !== previousLeaf &&
      isDescendant(thread.activeLeafMessageId, previousLeaf, parents) &&
      remote
    )
      thread.compactionPoints = remote.compactionPoints.filter((point) => pointStillExists(point, messages))
  }

  const newerThanSession = [...messages.values()].some(
    (message) => sessionDeletedAt === null || message.updatedAt > sessionDeletedAt,
  )
  const removedSession = sessionDeletedAt !== null && !newerThanSession
  const messageChanged =
    messages.size !== localIds.size ||
    [...messages.values()].some((message) => {
      const local = input.localMessages.find((item) => item.messageId === message.messageId)
      return (
        !local ||
        local.updatedAt !== message.updatedAt ||
        local.activeChildId !== message.activeChildId ||
        local.parentMessageId !== message.parentMessageId ||
        local.siblingOrder !== message.siblingOrder
      )
    })
  const threadChanged =
    threads.size !== input.localThreads.length ||
    [...threads.values()].some((thread) => {
      const local = input.localThreads.find((item) => item.threadId === thread.threadId)
      return (
        !local ||
        local.activeLeafMessageId !== thread.activeLeafMessageId ||
        local.threadOrder !== thread.threadOrder ||
        local.compactionPoints.length !== thread.compactionPoints.length
      )
    })
  const keptRemote = takenFromRemote.filter((message) => messages.has(message.messageId))
  return {
    removedSession,
    changed: removedSession || messageChanged || threadChanged || keptRemote.length > 0,
    messages: [...messages.values()],
    threads: [...threads.values()],
    resourceKeys: resourceKeys(keptRemote),
  }
}

export function selectBackupToMerge<T extends { id: string; createdAt: number }>(
  backups: readonly T[],
  uploadedIds: readonly string[],
  mergedIds: readonly string[],
): T | null {
  const seen = new Set([...uploadedIds, ...mergedIds])
  return (
    backups.filter((backup) => !seen.has(backup.id)).sort((left, right) => left.createdAt - right.createdAt)[0] ?? null
  )
}
