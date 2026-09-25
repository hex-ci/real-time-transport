<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus'
import type { SortableEvent } from 'vue-draggable-plus'
import type { UserFavoriteLine } from '@real-time-transport/shared'

const props = defineProps<{
  /** The rows as stored, in stored order — the model the drag library moves. */
  items: UserFavoriteLine[]
}>()

const emit = defineEmits<{
  (e: 'move', movedId: string, anchorId: string): void
}>()

/**
 * Report a finished drag as the two rows it joined: the one that was dragged
 * and the one whose slot it took.
 *
 * Both are named by id rather than by index because the order is one list over
 * every followed line — a caller that only knows the slice this component was
 * given could not tell where the drop belongs in the whole of it.
 *
 * Indices come from `items`, which is still the order as it stood before the
 * drop: that is what the library reports, and what makes 「the moved row takes
 * the anchor's slot」 mean the same thing here as it does in the stored order.
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
  <!--
    The library rewrites any model it is handed, but this list is derived from
    the store: its own rewrite is deliberately not wired up, and the emitted
    move is what changes the order, so the rows re-render from the one order
    everything else reads.

    `handle` is a real requirement, not a preference: with the whole row
    draggable, a finger scrolling the page or a tap opening the row would be
    read as the start of a drag. Only the grip starts one.
  -->
  <VueDraggable
    :model-value="items"
    :animation="160"
    handle="[data-drag-handle]"
    class="divide-y divide-slate-800/80"
    @end="onDragEnd"
  >
    <slot></slot>
  </VueDraggable>
</template>
