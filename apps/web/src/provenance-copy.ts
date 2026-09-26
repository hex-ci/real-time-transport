import type { DataProvenance } from '@real-time-transport/shared'

/**
 * 来源标记，作为使用者读到的那几个字。
 *
 * 一个数字属于哪一类，是在数据层决定的（`@real-time-transport/shared`）；这里只把它变成词，
 * 所以这套说法是可断言的事实，而不是只有浏览器能检查的模板 —— 这个应用没有 DOM 测试台。
 *
 * 三个标记说的是数字的「性质」，不指任何厂商、数据源或内部机制，且与词汇表一一对应：
 * 词汇表里没有的档，这里也不给词（曾有的「位置推算」随其生产者一同删除）。
 *
 * 来源未声明时返回 `null`，调用方什么都不渲染。这正是要点：「没有来源」和「实时」是两个
 * 事实，未知绝不能被凑成好听的那一个。
 */
export function provenanceLabelOf(provenance: DataProvenance | null | undefined): string | null {
  switch (provenance) {
    case 'live':
      return '实时'
    case 'schedule_simulation':
      return '排班推演'
    case 'exact_timetable':
      return '精确时刻表'
    default:
      return null
  }
}
