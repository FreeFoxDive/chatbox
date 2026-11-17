import { describe, expect, it } from 'vitest'
import { validateSessionTree } from '../session/session-tree/validate'
import type { MessageRow, SessionRecordV2, ThreadRow } from '../session/session-tree/types'
import { mergeConversation, selectBackupToMerge, type ConversationMerge } from './merge'
import { pruneTombstones } from './tombstones'

function message(
  id: string,
  parent: string | null,
  updatedAt: number,
  activeChildId: string | null = null,
): MessageRow {
  return {
    sessionId: 's',
    threadId: 't',
    messageId: id,
    parentMessageId: parent,
    activeChildId,
    siblingOrder: 0,
    kind: 'message',
    status: 'settled',
    createdAt: updatedAt,
    updatedAt,
    branchId: null,
    message: { id, role: 'user', contentParts: [{ type: 'text', text: id }] },
  }
}

function expectValid(merged: ConversationMerge) {
  if (merged.removedSession) return
  const active = merged.threads.find((item) => item.threadOrder === -1)
  const session = {
    id: 's',
    type: 'chat',
    name: 's',
    activeThreadId: active?.threadId ?? 't',
    storageFormat: 'rows',
    rowFormatVersion: 3,
  } satisfies SessionRecordV2
  expect(validateSessionTree({ session, threads: merged.threads, messages: merged.messages })).toEqual({ ok: true })
}

function thread(leaf: string | null, threadId = 't', threadOrder = -1): ThreadRow {
  return {
    sessionId: 's',
    threadId,
    threadOrder,
    name: null,
    createdAt: 1,
    rootMessageId: 'a',
    activeLeafMessageId: leaf,
    compactionPoints: [],
  }
}

describe('conversation merge', () => {
  it('adds a remote continuation and keeps a local-only message', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 1, 'local'), message('local', 'a', 2)],
      remoteMessages: [message('a', null, 1, 'remote'), message('remote', 'a', 3)],
      localThreads: [{ ...thread('a'), activeLeafMessageId: 'local' }],
      remoteThreads: [thread('remote')],
      tombstones: [],
    })
    expect(merged.removedSession).toBe(false)
    expect(merged.messages.map((item) => item.messageId).sort()).toEqual(['a', 'local', 'remote'])
    expect(merged.messages.find((item) => item.messageId === 'a')?.activeChildId).toBe('local')
    expect(merged.threads[0]?.activeLeafMessageId).toBe('local')
    const siblings = merged.messages.filter((item) => item.parentMessageId === 'a').map((item) => item.siblingOrder)
    expect(new Set(siblings).size).toBe(siblings.length)
    expectValid(merged)
  })

  it('follows one remote continuation from the local leaf', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 1)],
      remoteMessages: [message('a', null, 1, 'b'), message('b', 'a', 2)],
      localThreads: [thread('a')],
      remoteThreads: [thread('b')],
      tombstones: [],
    })
    expect(merged.messages.find((item) => item.messageId === 'a')?.activeChildId).toBe('b')
    expect(merged.threads[0]?.activeLeafMessageId).toBe('b')
    expectValid(merged)
  })

  it('keeps the newer copy of one message id', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 2)],
      remoteMessages: [message('a', null, 1)],
      localThreads: [thread('a')],
      remoteThreads: [thread('a')],
      tombstones: [],
    })
    expect(merged.messages[0]?.updatedAt).toBe(2)
    expectValid(merged)
    const reverse = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 1)],
      remoteMessages: [message('a', null, 4)],
      localThreads: [thread('a')],
      remoteThreads: [thread('a')],
      tombstones: [],
    })
    expect(reverse.messages[0]?.updatedAt).toBe(4)
    expectValid(reverse)
  })

  it('deletes only objects covered by a tombstone', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 1), message('b', 'a', 5)],
      remoteMessages: [message('a', null, 1)],
      localThreads: [thread('b')],
      remoteThreads: [thread('a')],
      tombstones: [{ kind: 'message', sessionId: 's', objectId: 'a', deletedAt: 2 }],
    })
    expect(merged.messages.map((item) => item.messageId)).toEqual(['b'])
    expect(merged.removedSession).toBe(false)
    expect(merged.messages[0]?.parentMessageId).toBeNull()
    expect(merged.threads[0]?.rootMessageId).toBe('b')
    expectValid(merged)
  })

  it('removes a session when every message is older than its deletion', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 2)],
      remoteMessages: [],
      localThreads: [thread('a')],
      remoteThreads: [],
      tombstones: [{ kind: 'session', sessionId: 's', objectId: 's', deletedAt: 3 }],
    })
    expect(merged.removedSession).toBe(true)
  })

  it('keeps one root when a deleted root had two children', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('root', null, 1, 'left'), message('left', 'root', 2), message('right', 'root', 2)],
      remoteMessages: [],
      localThreads: [thread('left')],
      remoteThreads: [],
      tombstones: [{ kind: 'message', sessionId: 's', objectId: 'root', deletedAt: 3 }],
    })
    expect(merged.messages.map((item) => item.messageId).sort()).toEqual(['left', 'right'])
    expect(merged.messages.filter((item) => item.parentMessageId === null)).toHaveLength(1)
    expectValid(merged)
  })

  it('clears an active child that was deleted', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 1, 'gone'), message('gone', 'a', 2), message('stay', 'a', 2)],
      remoteMessages: [],
      localThreads: [thread('gone')],
      remoteThreads: [],
      tombstones: [{ kind: 'message', sessionId: 's', objectId: 'gone', deletedAt: 4 }],
    })
    expect(merged.messages.find((item) => item.messageId === 'a')?.activeChildId).not.toBe('gone')
    expectValid(merged)
  })

  it('gives archived threads unique orders and names', () => {
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [],
      remoteMessages: [],
      localThreads: [thread(null), { ...thread(null, 'archived', 0), name: 'Old' }],
      remoteThreads: [thread(null, 'remote', 0)],
      tombstones: [],
    })
    const orders = merged.threads.map((item) => item.threadOrder)
    expect(new Set(orders).size).toBe(orders.length)
    expect(merged.threads.filter((item) => item.threadOrder !== -1).every((item) => item.name)).toBe(true)
    expectValid(merged)
  })

  it('drops compaction points that no longer point at a summary', () => {
    const summary = { ...message('sum', 'a', 2), kind: 'summary' as const }
    const merged = mergeConversation({
      sessionId: 's',
      localMessages: [message('a', null, 1), summary],
      remoteMessages: [],
      localThreads: [
        {
          ...thread('a'),
          compactionPoints: [
            { summaryMessageId: 'missing', boundaryMessageId: 'a', createdAt: 1 },
            { summaryMessageId: 'sum', boundaryMessageId: 'a', createdAt: 2 },
          ],
        },
      ],
      remoteThreads: [],
      tombstones: [],
    })
    expect(merged.threads[0]?.compactionPoints.map((point) => point.summaryMessageId)).toEqual(['sum'])
    expectValid(merged)
  })

  it('drops a tombstone beaten by a kept message and keeps one for an unloaded session', () => {
    const pruned = pruneTombstones(
      [
        { kind: 'message', sessionId: 's', objectId: 'a', deletedAt: 2 },
        { kind: 'message', sessionId: 's', objectId: 'old', deletedAt: 9 },
        { kind: 'session', sessionId: 's', objectId: 's', deletedAt: 2 },
        { kind: 'session', sessionId: 'other', objectId: 'other', deletedAt: 1 },
      ],
      [{ sessionId: 's', threadId: 't', messageId: 'a', updatedAt: 5 }],
    )
    expect(pruned.map((item) => `${item.kind}:${item.objectId}`).sort()).toEqual([
      'message:old',
      'session:other',
      'session:s',
    ])
  })

  it('selects the oldest snapshot this device has not merged', () => {
    const next = selectBackupToMerge(
      [
        { id: 'new', createdAt: 3 },
        { id: 'own', createdAt: 1 },
        { id: 'old', createdAt: 2 },
      ],
      ['own'],
      [],
    )
    expect(next?.id).toBe('old')
  })
})
