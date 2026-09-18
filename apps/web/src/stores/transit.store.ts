import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  LineDetail,
  LineGroup,
  LiveLineStatus,
  CommuteProfile,
  UserFavoriteLine,
  WsServerMessage,
} from '@real-time-transport/shared'

export const useTransitStore = defineStore('transit', () => {
  const currentLineDetail = ref<LineDetail | null>(null)
  const currentLiveStatus = ref<LiveLineStatus | null>(null)
  const commuteProfile = ref<CommuteProfile | null>(null)
  const favorites = ref<UserFavoriteLine[]>([])
  const wsConnected = ref(false)
  const isLoading = ref(false)
  /** True while a station tap triggers a live-status refetch. */
  const isRefreshingLive = ref(false)
  const loadError = ref<string | null>(null)

  let socket: WebSocket | null = null
  /** Line+direction currently subscribed, so a switch can unsubscribe cleanly. */
  let activeSubLineId: string | null = null
  let activeSubDirection: number | null = null
  let reconnectTimer: any = null

  async function fetchCommuteProfile(): Promise<void> {
    try {
      const res = await fetch('/api/transit/commute-profile')
      const json = await res.json()
      if (json.success) {
        commuteProfile.value = json.data
      }
    }
    catch (err) {
      console.warn('Failed to load commute profile:', err)
    }
  }

  async function fetchFavorites(): Promise<void> {
    try {
      const res = await fetch('/api/transit/favorites')
      const json = await res.json()
      if (json.success && Array.isArray(json.data)) {
        favorites.value = json.data
      }
    }
    catch {
      favorites.value = []
    }
  }

  /**
   * Search returns one entry per ROUTE with both directions attached — the user
   * follows a route, not a direction.
   */
  async function searchLines(keyword: string, cityCode: string = '027'): Promise<LineGroup[]> {
    try {
      const qs = new URLSearchParams({ keyword, cityCode })
      const res = await fetch(`/api/transit/lines/search?${qs.toString()}`)
      const json = await res.json()
      return json.success ? json.data : []
    }
    catch {
      return []
    }
  }

  /**
   * Clear the line-detail view's data. Called when LineDetailView unmounts, so
   * view-scoped state does not outlive the view (the root cause of briefly
   * seeing the previous line when opening a different one from home).
   *
   * isLoading is left true on purpose: the next time the view mounts, its first
   * paint reads detail=null + isLoading=true and shows the loading state, rather
   * than flashing the "line not found" error branch before loadLine() resolves.
   *
   * Switching up/down direction does NOT unmount the view (same route record, so
   * Vue Router reuses the instance), which is exactly why this stays out of that
   * transition and its smooth, stable behaviour is untouched.
   */
  function resetLineData(): void {
    currentLineDetail.value = null
    currentLiveStatus.value = null
    loadError.value = null
    isLoading.value = true
  }

  /**
   * Re-fetch ONLY the live vehicle status for the line currently on screen.
   * Used when the user taps a station and expects fresh numbers: refetching the
   * static detail too would rebuild the board and disturb the map they are
   * looking at.
   */
  async function refreshLive(): Promise<void> {
    const detail = currentLineDetail.value
    if (!detail) return
    isRefreshingLive.value = true
    try {
      const qs = new URLSearchParams({
        direction: String(detail.direction),
        cityCode: detail.cityCode,
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(detail.lineId)}/live?${qs.toString()}`)
      const json = await res.json()
      // Keep the existing data on a failed refresh rather than blanking the view.
      if (json.success && json.data) {
        currentLiveStatus.value = json.data
      }
    }
    catch {
      // Ignore: WS pushes will keep the view fresh anyway.
    }
    finally {
      isRefreshingLive.value = false
    }
  }

  async function loadLine(lineId: string, direction: number = 0, cityCode?: string): Promise<void> {
    isLoading.value = true
    loadError.value = null
    try {
      const qs = new URLSearchParams({ direction: String(direction) })
      if (cityCode) qs.set('cityCode', cityCode)
      const query = qs.toString()

      const [detailRes, liveRes] = await Promise.allSettled([
        fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${query}`).then(r => r.json()),
        fetch(`/api/transit/lines/${encodeURIComponent(lineId)}/live?${query}`).then(r => r.json()),
      ])

      if (detailRes.status === 'fulfilled' && detailRes.value.success) {
        currentLineDetail.value = detailRes.value.data
      }
      else {
        // Upstream failed or line does not exist: show empty state honestly
        currentLineDetail.value = null
        currentLiveStatus.value = null
        loadError.value = (detailRes.status === 'fulfilled' && detailRes.value.error)
          ? String(detailRes.value.error)
          : '线路数据加载失败'
      }
      if (liveRes.status === 'fulfilled' && liveRes.value.success) {
        currentLiveStatus.value = liveRes.value.data
      }

      if (currentLineDetail.value) {
        subscribeWs(lineId, direction, cityCode)
      }
    }
    finally {
      isLoading.value = false
    }
  }

  function initWs(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws`

    try {
      socket = new WebSocket(wsUrl)
      socket.onopen = () => {
        wsConnected.value = true
        if (activeSubLineId && currentLineDetail.value) {
          subscribeWs(activeSubLineId, currentLineDetail.value.direction, currentLineDetail.value.cityCode)
        }
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsServerMessage
          if (msg.type !== 'line_update') return
          const detail = currentLineDetail.value
          if (!detail) return
          // Match lineId AND direction: a subway line serves both directions
          // under one lineId, so matching lineId alone could paint the opposite
          // direction's vehicles onto the current view.
          if (msg.lineId !== detail.lineId) return
          const msgDir = typeof msg.direction === 'number' ? msg.direction : detail.direction
          if (msgDir !== detail.direction) return
          currentLiveStatus.value = msg.status
        }
        catch {
          // Ignore malformed WS frame
        }
      }

      socket.onclose = () => {
        wsConnected.value = false
        socket = null
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => initWs(), 3000)
      }

      socket.onerror = () => {
        socket?.close()
      }
    }
    catch {
      // WS error
    }
  }

  function sendUnsubscribe(lineId: string, direction: number): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'unsubscribe', lineId, direction }))
    }
  }

  function subscribeWs(lineId: string, direction: number = 0, cityCode?: string): void {
    // Leaving a different line/direction: stop its server-side polling so we do
    // not keep pushing updates for a view the user already left.
    if (activeSubLineId !== null && activeSubDirection !== null) {
      const changedLine = activeSubLineId !== lineId
      const changedDir = activeSubDirection !== direction
      if (changedLine || changedDir) {
        sendUnsubscribe(activeSubLineId, activeSubDirection)
      }
    }

    activeSubLineId = lineId
    activeSubDirection = direction
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        action: 'subscribe',
        lineId,
        direction,
        cityCode: cityCode || '027',
      }))
    }
  }

  async function addFavorite(item: {
    lineId: string
    lineName: string
    preferredDirection?: number
    reverseLineId?: string
    cityCode?: string
  }): Promise<void> {
    const res = await fetch('/api/transit/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'default_user',
        cityCode: item.cityCode || '027',
        lineId: item.lineId,
        lineName: item.lineName,
        preferredDirection: item.preferredDirection ?? 0,
        reverseLineId: item.reverseLineId,
        displayOrder: favorites.value.length + 1,
      }),
    })
    const json = await res.json()
    if (json.success && json.data) {
      const saved: UserFavoriteLine = json.data
      // The server merges a re-followed route into the existing row, so
      // replace it in place instead of appending a duplicate card.
      const idx = favorites.value.findIndex(f => f.id === saved.id)
      if (idx >= 0) {
        favorites.value[idx] = saved
      }
      else {
        favorites.value.push(saved)
      }
      return
    }
    throw new Error(json.error || '关注失败')
  }

  async function removeFavorite(idOrIndex: string | number): Promise<void> {
    let target: UserFavoriteLine | undefined
    if (typeof idOrIndex === 'number') {
      target = favorites.value[idOrIndex]
    }
    else {
      target = favorites.value.find(f => f.id === idOrIndex || f.lineId === idOrIndex)
    }

    if (target?.id) {
      const res = await fetch(`/api/transit/favorites/${target.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json.success) {
        throw new Error(json.error || '取消关注失败')
      }
    }

    favorites.value = favorites.value.filter(f => f !== target)
  }

  return {
    currentLineDetail,
    currentLiveStatus,
    commuteProfile,
    favorites,
    wsConnected,
    isLoading,
    isRefreshingLive,
    loadError,
    fetchCommuteProfile,
    fetchFavorites,
    searchLines,
    loadLine,
    refreshLive,
    resetLineData,
    initWs,
    addFavorite,
    removeFavorite,
  }
})
