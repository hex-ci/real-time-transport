<script setup lang="ts">
/**
 * 一份可拖动的、编辑**存储顺序**的列表 —— 关注线路与通勤链路共用。
 *
 * 行本身由调用方通过插槽渲染（它们各不相同），本组件只把它们包进拖拽容器，并把一次拖放
 * 报告成它接合的那两行。顺序是存储里的一列（`displayOrder`），故拖动即是写入：它没有本地的
 * 顺序副本。
 */
import { VueDraggable } from 'vue-draggable-plus'
import type { SortableEvent } from 'vue-draggable-plus'

/** 可排序的一行只需要 id：一次拖放说的就是「哪一行去了哪一行的格子」。 */
interface DragOrderRow {
  id?: string
}

const props = defineProps<{
  /** 存储中的各行，按存储顺序 —— 拖拽库所移动的那个模型。 */
  items: DragOrderRow[]
  /** 容器的标签：关注线路列表是一个 `div`，链路列表是一份 `<ul>`。 */
  tag?: string
}>()

const emit = defineEmits<{
  (e: 'move', movedId: string, anchorId: string): void
}>()

/**
 * 把一次完成的拖放报告成它接合的两行：被拖走的那一行，以及它占据其格子的那一行。
 *
 * 两者用 id 而非下标命名，因为顺序是一份横跨每一行的「一份」列表 —— 只知道本组件拿到的那
 * 一段的调用方，说不出这次落点在整份列表的哪里。
 *
 * 下标来自 `items`，它仍是落点之前那个顺序：那正是拖拽库报告的东西，也正使「被移动的行占据
 * 锚点的格子」在这里与在存储顺序里指的是同一件事。
 */
function onDragEnd(event: SortableEvent): void {
  const from = event.oldIndex ?? -1
  const to = event.newIndex ?? -1
  if (from < 0 || to < 0 || from === to) return

  const moved = props.items[from]
  const anchor = props.items[to]
  if (!moved?.id || !anchor?.id || moved.id === anchor.id) return

  emit('move', moved.id, anchor.id)
}
</script>

<template>
  <!-- 拖拽库会重写交给它的任何模型，但这份列表是从 store 推导出来的：它自己的重写刻意没有接上，
       改变顺序的是发出的那个 move，于是各行从所有人读的那一个顺序重新渲染。`handle` 是硬性要求
       而不是偏好：整行可拖时，滚动页面的手指或打开该行的一次点按都会被读成拖拽的开始。只有抓手
       会开始一次拖拽。 -->
  <VueDraggable
    :model-value="items"
    :tag="tag"
    :animation="160"
    handle="[data-drag-handle]"
    @end="onDragEnd"
  >
    <slot></slot>
  </VueDraggable>
</template>
