<script setup lang="ts">
import { computed, h } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { collab } from '@/collab/collab'
import { needsLeaveConfirm, unsyncedDetailLines } from '@/collab/leaveGuard'
import { ROLE_LABEL } from '../../../shared/protocol'
import UserAvatar from '@/components/UserAvatar.vue'

const session = useSessionStore()
const doc = useDocStore()

const connTag = computed(() => {
  switch (session.status) {
    case 'online':
      return { type: 'success' as const, text: '已连接' }
    case 'connecting':
      return { type: 'info' as const, text: '连接中…' }
    case 'reconnecting':
      return { type: 'warning' as const, text: `重连中(${session.reconnectAttempt})` }
    default:
      return { type: 'danger' as const, text: '已离线' }
  }
})

const syncTag = computed(() => {
  switch (doc.syncState) {
    case 'synced':
      return { type: 'success' as const, text: '已同步' }
    case 'pending':
      return { type: 'warning' as const, text: '同步中…' }
    default:
      return { type: 'info' as const, text: '重同步中…' }
  }
})

const roleTagType = computed(() => {
  if (session.role === 'editor') return 'primary'
  if (session.role === 'commenter') return 'warning'
  return 'info'
})

function toggleOffline() {
  if (session.status === 'offline') {
    collab.reconnectNow()
  } else {
    collab.simulateDrop()
  }
}

/**
 * 退出文档：已同步时直接退出；
 * 存在待确认编辑 / 待发送批注 / 重同步中时弹窗展示待同步数量，
 * 由用户选择「放弃修改并退出」或「取消」继续编辑。
 */
async function quit() {
  const summary = collab.getUnsyncedSummary()
  if (needsLeaveConfirm(summary)) {
    try {
      await ElMessageBox.confirm(
        h('div', [
          h('p', { style: 'margin: 0 0 8px' }, '以下本地修改尚未同步到服务器，退出后将丢失：'),
          h(
            'ul',
            { style: 'margin: 0; padding-left: 18px' },
            unsyncedDetailLines(summary).map((line) => h('li', line)),
          ),
        ]),
        '未同步的修改',
        {
          type: 'warning',
          confirmButtonText: '放弃修改并退出',
          cancelButtonText: '取消',
        },
      )
    } catch {
      return // 取消退出，继续留在文档编辑
    }
  }
  collab.leave()
}
</script>

<template>
  <div class="topbar">
    <span class="doc-title">📄 {{ session.docId }}</span>
    <el-tag size="small" :type="connTag.type" effect="light">{{ connTag.text }}</el-tag>
    <el-tag size="small" :type="syncTag.type" effect="plain">{{ syncTag.text }}</el-tag>
    <el-tag size="small" :type="roleTagType" effect="dark">{{ ROLE_LABEL[session.role] }}</el-tag>
    <span style="font-size: 12px; color: #909399">v{{ doc.revision }}</span>

    <div class="spacer" />

    <div class="user-avatars">
      <el-tooltip
        v-for="u in session.users"
        :key="u.clientId"
        :content="`${u.name}（${ROLE_LABEL[u.role]}）${u.clientId === session.clientId ? ' - 我' : ''}`"
        placement="bottom"
      >
        <UserAvatar :user="u" />
      </el-tooltip>
    </div>

    <el-button
      size="small"
      :type="session.status === 'offline' ? 'success' : 'warning'"
      plain
      @click="toggleOffline"
    >
      {{ session.status === 'offline' ? '重新连接' : '模拟断线' }}
    </el-button>
    <el-button size="small" plain @click="quit">退出</el-button>
  </div>
</template>
