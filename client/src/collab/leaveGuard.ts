/**
 * 退出确认（leave guard）：退出文档前汇总本地未同步内容，决定是否需要弹窗确认。
 *
 * 未同步内容的三个来源：
 * - 待确认编辑：OT 客户端未确认队列（离线暂存 / 已发送待 ack）；
 * - 待发送批注：断线期间在 WS 发送队列中排队、尚未补发的批注消息；
 * - 重同步中：正在与服务端对齐版本，本地未确认操作的最终去向尚未确定。
 *
 * 纯逻辑模块：不依赖 Vue / element-plus / Pinia，便于在 node 测试中直接验证。
 */

export interface UnsyncedSummary {
  /** 待确认编辑数（OT 未确认操作） */
  pendingEdits: number
  /** 待发送批注消息数（离线排队待补发） */
  pendingAnnotations: number
  /** 是否正在重同步 */
  resyncing: boolean
}

/** 是否存在未同步内容：有则退出前需用户确认，否则可直接退出 */
export function needsLeaveConfirm(s: UnsyncedSummary): boolean {
  return s.resyncing || s.pendingEdits > 0 || s.pendingAnnotations > 0
}

/** 未同步内容明细行（确认弹窗中向用户展示各项数量） */
export function unsyncedDetailLines(s: UnsyncedSummary): string[] {
  const lines: string[] = []
  if (s.pendingEdits > 0) lines.push(`${s.pendingEdits} 处编辑待同步`)
  if (s.pendingAnnotations > 0) lines.push(`${s.pendingAnnotations} 条批注待发送`)
  if (s.resyncing) lines.push('正在与服务器重新同步')
  return lines
}
