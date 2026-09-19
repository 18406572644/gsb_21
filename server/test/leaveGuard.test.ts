/**
 * 退出确认（leave guard）四场景验收：正常退出 / 断线退出 / 重同步中退出 / 离线编辑。
 *
 * 使用真实的 OTClient（待确认编辑队列）与 WSClient（待补发消息队列），
 * 按 collab.getUnsyncedSummary 相同的口径汇总未同步状态，
 * 验证「是否弹确认框」与「弹窗展示的待同步数量」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { diffToOp, type Op } from '../../shared/ot'
import { OTClient } from '../../client/src/ot/otClient'
import { WSClient } from '../../client/src/ws/wsClient'
import {
  needsLeaveConfirm,
  unsyncedDetailLines,
  type UnsyncedSummary,
} from '../../client/src/collab/leaveGuard'

async function waitFor(cond: () => boolean, timeout = 3000, step = 25): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, step))
  }
}

/** 与 collab.getUnsyncedSummary 相同的汇总口径 */
function summaryOf(ot: OTClient, ws: WSClient, resyncing: boolean): UnsyncedSummary {
  return {
    pendingEdits: ot.pendingCount,
    pendingAnnotations: ws.outboxCount('ann:'),
    resyncing,
  }
}

function newOT(sendOp: (op: Op, opId: string, revision: number) => void) {
  const ot = new OTClient({ sendOp, applyRemote: () => {}, requestResync: () => {} })
  ot.minSendInterval = 0
  return ot
}

test('正常退出：编辑已确认、无待发送批注（已同步），直接退出不弹确认框', () => {
  const sent: { opId: string }[] = []
  const ot = newOT((_op, opId) => sent.push({ opId }))
  const ws = new WSClient()
  ot.setConnected(true)

  // 在线编辑一条并收到服务端 ack → 全部同步
  ot.localChange(diffToOp('', 'hello'))
  assert.equal(sent.length, 1)
  ot.ack(sent[0]!.opId, 1)

  const s = summaryOf(ot, ws, false)
  assert.equal(needsLeaveConfirm(s), false)
  assert.deepEqual(unsyncedDetailLines(s), [])
})

test('断线退出：断线期间有待确认编辑与待发送批注，需确认并展示数量', () => {
  const ot = newOT(() => {})
  const ws = new WSClient()
  // 断线（从未连接）：编辑暂存在 OT 未确认队列
  ot.localChange(diffToOp('', '离线编辑'))
  // 批注消息进入 WS 待补发队列；光标等易失消息直接丢弃不计数
  ws.send({ type: 'ann:add', annId: 'a1', start: 0, end: 1, quote: '离', text: '批注1' })
  ws.send({ type: 'ann:reply', annId: 'a1', replyId: 'r1', text: '回复' })
  ws.send({ type: 'cursor', start: 0, end: 0 })

  assert.equal(ws.outboxCount(), 2, '易失消息不应进入待补发队列')
  const s = summaryOf(ot, ws, false)
  assert.equal(needsLeaveConfirm(s), true)
  assert.deepEqual(unsyncedDetailLines(s), ['1 处编辑待同步', '2 条批注待发送'])
})

test('断线退出：断线但全部已同步，可直接退出', () => {
  const sent: { opId: string }[] = []
  const ot = newOT((_op, opId) => sent.push({ opId }))
  const ws = new WSClient()
  // 在线时编辑并全部确认，随后连接断开（OT 置为未连接）
  ot.setConnected(true)
  ot.localChange(diffToOp('', 'x'))
  ot.ack(sent[0]!.opId, 1)
  ot.setConnected(false)

  assert.equal(needsLeaveConfirm(summaryOf(ot, ws, false)), false)
})

test('重同步中退出：重同步进行中需确认，即使待同步数量为 0', () => {
  const ot = newOT(() => {})
  const ws = new WSClient()
  const s = summaryOf(ot, ws, true)
  assert.equal(needsLeaveConfirm(s), true)
  assert.deepEqual(unsyncedDetailLines(s), ['正在与服务器重新同步'])
})

test('重同步中退出：重同步中且有未确认编辑，明细同时展示', () => {
  const ot = newOT(() => {})
  ot.localChange(diffToOp('', 'abc'))
  const s = summaryOf(ot, new WSClient(), true)
  assert.deepEqual(unsyncedDetailLines(s), ['1 处编辑待同步', '正在与服务器重新同步'])
})

test('离线编辑：暂存时需确认；重连补发并同步完成后可直接退出', async () => {
  // 迷你服务端：记录上行消息，收到 op 立即回 ack
  const received: { type?: string }[] = []
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type?: string; opId?: string }
      received.push(m)
      if (m.type === 'op') sock.send(JSON.stringify({ type: 'ack', opId: m.opId, revision: 1 }))
    })
  })
  await new Promise<void>((r) => wss.on('listening', r))
  const port = (wss.address() as AddressInfo).port

  // 与 collab.ts 相同的接线：OT 发送走 WS，ack 回到 OT
  const ws = new WSClient()
  const ot = newOT((op, opId, revision) => ws.send({ type: 'op', op, opId, revision }))
  ws.onMessage = (raw) => {
    const m = raw as { type?: string; opId?: string; revision?: number }
    if (m.type === 'ack') ot.ack(m.opId!, m.revision!)
  }

  try {
    // 离线期间：编辑暂存 OT 队列，批注进入待补发队列 → 退出需确认并展示数量
    ot.localChange(diffToOp('', '离线内容'))
    ws.send({ type: 'ann:add', annId: 'a1', start: 0, end: 1, quote: '离', text: '离线批注' })
    const offline = summaryOf(ot, ws, false)
    assert.equal(needsLeaveConfirm(offline), true)
    assert.deepEqual(unsyncedDetailLines(offline), ['1 处编辑待同步', '1 条批注待发送'])

    // 重连：与 collab.finishResync 相同 —— OT 恢复发送，补发 outbox
    ws.connect(`ws://localhost:${port}/ws`)
    await waitFor(() => ws.status === 'online')
    ot.setConnected(true)
    ws.flushOutbox()

    // 操作获 ack、批注补发到达 → 全部同步，可直接退出
    await waitFor(() => ot.pendingCount === 0 && ws.outboxCount('ann:') === 0)
    assert.ok(received.some((m) => m.type === 'op'), '离线编辑应补发到达服务端')
    assert.ok(received.some((m) => m.type === 'ann:add'), '离线批注应补发到达服务端')
    assert.equal(needsLeaveConfirm(summaryOf(ot, ws, false)), false)
  } finally {
    ws.disconnect()
    wss.close()
  }
})
