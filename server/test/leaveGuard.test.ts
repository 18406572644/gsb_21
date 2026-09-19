/**
 * 验收测试：离开文档前的未同步修改确认机制。
 *
 * 用真实 WSClient（Node 22 全局 WebSocket）+ 真实 OTClient + leaveGuard 纯逻辑，
 * 以与 client/src/collab/collab.ts 相同的接线方式驱动完整链路，覆盖四个场景：
 *
 * 1. 正常退出：已全部同步（含已 ack 的编辑）→ 无弹窗直接退出，服务端内容保留；
 * 2. 断线退出：离线期间有未确认编辑 + 待发送批注 → 弹窗列出数量，
 *    「取消」不动本地状态，「放弃本地修改并离开」→ 队列清空且服务端从未收到；
 * 3. 重同步中退出：重连增量同步的 welcome→ops 窗口内 resyncing=true → 弹窗 info 提示；
 * 4. 离线编辑：弹窗选择「继续编辑」后重连，离线编辑与批注确实自动同步收敛。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { apply, diffToOp } from '../../shared/ot'
import type { ServerMsg } from '../../shared/protocol'
import { WSClient } from '../../client/src/ws/wsClient'
import { OTClient } from '../../client/src/ot/otClient'
import {
  buildLeavePrompt,
  collectUnsynced,
  discardLocalChanges,
  hasUnsynced,
  summarizeUnsynced,
} from '../../client/src/collab/leaveGuard'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PORT = '18095'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-leave-'))
const { server, shutdown, getSession } = await import('../src/index')

const BASE_URL = 'ws://localhost:18095/ws'

async function waitFor(cond: () => boolean, timeout = 5000, step = 20): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, step))
  }
}

let docSeq = 0

/**
 * 无头协同客户端：collab.ts 的最小复刻（不涉及 Pinia / Element Plus），
 * 接线方式与生产代码保持一致：WSClient 负责连接与离线队列，OTClient 负责未确认编辑。
 */
class HeadlessCollab {
  ws = new WSClient()
  ot: OTClient
  doc = ''
  resyncing = false
  joinedOnce = false
  docId = ''
  private ready: (() => void) | null = null
  /** welcome（增量）到达、ops 尚未处理的「重同步中」窗口钩子 */
  onResyncWindow: (() => void) | null = null

  constructor() {
    this.ot = new OTClient({
      sendOp: (op, opId, revision) => this.ws.send({ type: 'op', op, opId, revision }),
      applyRemote: (op) => {
        this.doc = apply(this.doc, op)
      },
      requestResync: () => {
        this.resyncing = true
        this.ws.send({ type: 'resync', lastRevision: this.ot.revision })
      },
    })
    this.ot.minSendInterval = 0
    this.ot.ackTimeoutMs = 2000

    this.ws.onStatus = (status) => {
      if (status !== 'online') this.ot.setConnected(false)
    }
    this.ws.onOpen = () => {
      this.ws.send({
        type: 'join',
        docId: this.docId,
        name: 'headless',
        role: 'editor',
        lastRevision: this.joinedOnce ? this.ot.revision : undefined,
      })
    }
    this.ws.onMessage = (raw) => this.handle(raw as ServerMsg)
  }

  /** 退出检查：与 Collab.unsyncedBeforeLeave 相同的采集路径 */
  unsynced() {
    return collectUnsynced(this.ot, this.ws, this.resyncing)
  }

  async join(docId?: string) {
    this.docId = docId ?? `leave-doc-${++docSeq}`
    const p = new Promise<void>((resolve) => (this.ready = resolve))
    this.ws.connect(BASE_URL)
    await p
  }

  disconnect() {
    this.ws.disconnect()
  }

  reconnect() {
    this.ws.connect(BASE_URL)
  }

  /** 与 collab.localEdit 相同的 diff 路径 */
  type(text: string, pos?: number) {
    const p = pos ?? this.doc.length
    const next = this.doc.slice(0, p) + text + this.doc.slice(p)
    const op = diffToOp(this.doc, next)
    this.doc = next
    this.ot.localChange(op)
  }

  /** 批注动作（与 collab.addAnnotation 相同，走 ws 离线队列） */
  sendAnnotation(text: string) {
    this.ws.send({
      type: 'ann:add',
      annId: `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      start: 0,
      end: 0,
      quote: '',
      text,
    })
  }

  /** 放弃本地修改并离开：与 Collab.leave 的放弃路径一致 */
  leaveDiscarding() {
    discardLocalChanges(this.ot, this.ws)
    this.ws.disconnect()
    this.resyncing = false
  }

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome':
        this.joinedOnce = true
        this.resyncing = true
        if (msg.snapshot) {
          this.ot.rollback(msg.revision)
          this.doc = msg.doc
          this.resyncing = false
          this.ot.setConnected(true)
          this.ready?.()
          this.ready = null
        } else {
          // 增量路径：与 collab 一致，welcome 后进入 resyncing，ops 到达才结束
          this.onResyncWindow?.()
        }
        break
      case 'ops':
        this.ot.resyncOps(msg.ops, msg.revision)
        this.resyncing = false
        this.ot.setConnected(true)
        this.ws.flushOutbox()
        this.ready?.()
        this.ready = null
        break
      case 'op':
        this.ot.remoteChange(msg.op)
        break
      case 'ack':
        this.ot.ack(msg.opId, msg.revision)
        break
    }
  }
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('场景1 正常退出：已同步时无确认弹窗，直接退出且服务端保留内容', async () => {
  const a = new HeadlessCollab()
  await a.join()

  // 刚加入、无任何编辑：已同步
  let summary = a.unsynced()
  assert.equal(hasUnsynced(summary), false)
  assert.equal(buildLeavePrompt(summary), null)

  // 一次完整同步的编辑（已收到 ack）
  a.type('已保存的内容')
  await waitFor(() => a.ot.pendingCount === 0)
  assert.ok(getSession(a.docId).doc.includes('已保存的内容'))

  // 仍无未同步内容 → 直接退出
  summary = a.unsynced()
  assert.deepEqual(summary, { pendingEditGroups: 0, pendingAnnotations: 0, resyncing: false })
  assert.equal(buildLeavePrompt(summary), null)
  a.leaveDiscarding()

  // 已同步的内容不随退出丢失
  assert.equal(a.ot.pendingCount, 0)
  assert.equal(a.ws.pendingCount, 0)
})

test('场景2 断线退出：弹窗展示待确认编辑与待发送批注数量，取消保留 / 放弃清空且不上送', async () => {
  const docId = 'leave-scenario-disconnect'
  const a = new HeadlessCollab()
  await a.join(docId)

  a.disconnect()
  // 离线期间：多次正文编辑被 compose 为 1 个待确认操作组；2 条批注进入发送队列
  a.type('离线一')
  a.type('离线二')
  a.sendAnnotation('离线批注 A')
  a.sendAnnotation('离线批注 B')

  const summary = a.unsynced()
  assert.equal(summary.resyncing, false)
  assert.equal(summary.pendingEditGroups, 1)
  assert.equal(summary.pendingAnnotations, 2)
  assert.equal(hasUnsynced(summary), true)

  const prompt = buildLeavePrompt(summary)!
  assert.equal(prompt.severity, 'warning')
  assert.equal(prompt.reasons.length, 2)
  assert.ok(prompt.reasons.some((r) => r.includes('1 组') && r.includes('编辑')))
  assert.ok(prompt.reasons.some((r) => r.includes('2 条') && r.includes('批注')))
  assert.equal(prompt.confirmText, '放弃本地修改并离开')
  assert.equal(prompt.cancelText, '继续编辑')

  // 用户选择「取消 / 继续编辑」：本地状态原样保留
  // （不调用 discard，这里仅通过再次检查状态确认未被破坏）
  assert.equal(a.ot.pendingCount, 1)
  assert.equal(a.ws.pendingAnnotationCount, 2)

  // 用户确认「放弃本地修改并离开」
  a.leaveDiscarding()
  assert.equal(a.ot.pendingCount, 0)
  assert.equal(a.ws.pendingCount, 0)
  assert.equal(a.ws.pendingAnnotationCount, 0)

  // 服务端自始至终没有收到这些离线内容
  const serverSession = getSession(docId)
  assert.ok(!serverSession.doc.includes('离线一'))
  assert.ok(!serverSession.doc.includes('离线二'))
  assert.equal(serverSession.annotations.size, 0)
})

test('场景3 重同步中退出：welcome→ops 窗口内提示重同步中，完成后恢复直接退出', async () => {
  const a = new HeadlessCollab()
  await a.join()
  a.type('X')
  await waitFor(() => a.ot.pendingCount === 0 && a.ot.revision === 1)

  // 重连走增量路径：welcome(snapshot:false) 与 ops 是两个独立帧，
  // 在 collab 中 welcome 处理后置 resyncing=true，直到 ops 才结束
  const resyncWindows: ReturnType<HeadlessCollab['unsynced']>[] = []
  a.onResyncWindow = () => resyncWindows.push(a.unsynced())
  a.disconnect()
  a.reconnect()
  await waitFor(() => a.resyncing === false && resyncWindows.length > 0)

  const win = resyncWindows[0]!
  assert.equal(win.resyncing, true)
  assert.equal(hasUnsynced(win), true)
  const resyncPrompt = buildLeavePrompt(win)!
  assert.equal(resyncPrompt.severity, 'info', '仅重同步中、无待同步内容时为 info')
  assert.equal(resyncPrompt.reasons.length, 1)
  assert.ok(resyncPrompt.reasons[0].includes('重同步'))

  // 重同步完成：无未同步内容 → 可直接退出
  await waitFor(() => !hasUnsynced(a.unsynced()))
  assert.equal(buildLeavePrompt(a.unsynced()), null)
  a.leaveDiscarding()
})

test('场景4 离线编辑：取消退出后重连，离线编辑与批注自动同步收敛', async () => {
  const docId = 'leave-scenario-offline-edit'
  const a = new HeadlessCollab()
  await a.join(docId)

  a.disconnect()
  a.type('[离线保留]')
  a.sendAnnotation('离线批注会补发')

  const summary = a.unsynced()
  assert.equal(summary.pendingEditGroups, 1)
  assert.equal(summary.pendingAnnotations, 1)
  assert.ok(buildLeavePrompt(summary))

  // 用户在弹窗中选择「继续编辑」：不丢弃任何内容，随后网络恢复
  a.reconnect()
  await waitFor(() => a.ot.pendingCount === 0)
  await waitFor(() => getSession(docId).annotations.size === 1)

  // 离线编辑与批注都已上送，文档收敛
  assert.ok(a.doc.includes('[离线保留]'))
  assert.ok(getSession(docId).doc.includes('[离线保留]'))
  assert.equal(getSession(docId).annotations.size, 1)

  // 收敛后退出不再弹窗
  assert.equal(hasUnsynced(a.unsynced()), false)
  assert.equal(buildLeavePrompt(a.unsynced()), null)
  a.leaveDiscarding()
})

test('弹窗文案：三类待同步内容同时存在时逐条列出数量', () => {
  const prompt = buildLeavePrompt(summarizeUnsynced({ pendingEditGroups: 3, pendingAnnotations: 2, resyncing: true }))!
  assert.equal(prompt.severity, 'warning')
  assert.equal(prompt.reasons.length, 3)
  assert.ok(prompt.reasons[0].includes('3 组'))
  assert.ok(prompt.reasons[1].includes('2 条'))
  assert.ok(prompt.reasons[2].includes('重同步'))
})
