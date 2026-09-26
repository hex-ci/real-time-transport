import { afterEach, beforeEach, expect, it } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * 读不到 ≠ 空：同一次读取的三种结局各有自己的形状。
 *
 * 一次读取有三种结果，不能互换（`docs/PRD.md` §4.1、`apps/web/src/read-state.ts`）：还在读、
 * 读了而没答上来、读到了（哪怕读到的是「一辆车都没有」）。后者是**关于存了什么**的主张，
 * 前两者不是 —— 把读失败渲染成空列表，就是替一次没答上来的读取作主张。
 *
 * 这里在两个接口上各钉一遍：
 *
 *  - `GET /lines/:id/live`：「线路在、此刻没车」是 200 与一个说出线路名的空列表；上游没答
 *    是拒绝（404，`success: false`、有点名原因的 error），且不带任何可以当列表印出去的值。
 *  - `POST /refresh`：三种互不可替换的事实各有状态码 —— 答了 200、什么都没读 429、
 *    读了而都没答 502 —— 而不是都用 200 与一份空读数作答。
 *  - `GET /settings`：确实为空是一个**词**（`settingsState: 'unset'` 与 `data: null`）配 200，
 *    失败不是这个词所表达的东西；读到了是同一个接口的另一个词。
 *
 * 上游一律走 harness 的桩：默认的桩拒绝一切调用（那正是「读了而没答」），要数据自己装回答。
 */
describeEachStore('读不到 ≠ 空：三种结局各有自己的形状', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /** 一条存在的公交线路：线路名与站表就是它的身份（没有车也一样存在）。 */
  const LINE = 'line_027_1'
  const STATIONS = [
    { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
    { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
    { sId: 's3', sn: '丙路', order: 3, lat: 39.92, lng: 116.42 },
    { sId: 's4', sn: '丁路', order: 4, lat: 39.93, lng: 116.43 },
  ]

  /** 让上游对这条线路作答；`buses` 就是此刻的在途车辆。 */
  function answerWith(buses: unknown[]): void {
    api.upstream.mockImplementation(async (url: unknown) => {
      const href = String(url)
      if (!href.includes('encryptedLineDetail')) throw new Error(`TEST: 未桩掉的上游调用 ${href}`)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonr: {
            data: {
              line: { name: '甲路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
              stations: STATIONS,
              buses,
            },
          },
        }),
      }
    })
  }

  /** 让上游这次不答：拒绝一切调用，走的是聚合器的失败分支。 */
  function upstreamAnsweringNothing(): void {
    api.upstream.mockImplementation(async (url: unknown) => {
      throw new Error(`TEST: 上游不答 ${String(url)}`)
    })
  }

  const live = (lineId = LINE) =>
    api.inject({ method: 'GET', url: `/api/transit/lines/${lineId}/live?direction=0&cityCode=027` })

  const refresh = (userId: string) => api.inject({
    method: 'POST',
    url: '/api/transit/refresh',
    payload: { userId, lines: [{ lineId: LINE, direction: 0, cityCode: '027' }] },
  })

  it('确实为空：上游答了这条线路、此刻没有车 —— 200 与一个说出线路名的空列表', async () => {
    answerWith([])
    const res = await live()

    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.success, 'a line with no vehicle in service is not a failure').toBe(true)
    expect(body.data.buses).toEqual([])
    // 空列表是关于这条线路的答案：它点名自己说的是谁，因此不会与「没答上来」混同。
    expect(body.data.lineId, 'an empty answer must name the line it is about').toBe(LINE)
  })

  it('读失败：上游没答 —— 拒绝，绝不是 200 与一个空列表', async () => {
    upstreamAnsweringNothing()
    const res = await live()

    expect(res.statusCode, `a failed read was served as an answer: ${res.body}`).not.toBe(200)
    expect(res.statusCode, res.body).toBe(404)
    const body = res.json()
    expect(body.success).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(body.error.length, 'the refusal must say why').toBeGreaterThan(0)
    // 没答上来就不该有可以当列表印出去的值：空数组冒充读失败正是这条规则要挡住的东西。
    expect(body.data, 'a failed read handed back a list').toBeUndefined()
  })

  it('两种结局同时可见：状态码与形状都不同，谁也不会被读成另一个', async () => {
    // 两条不同的线路：读数按 (lineId, direction) 缓存，同一条线路的第二次读取会拿缓存
    // 作答 —— 那正是「读到了」，测不出「读不到」。
    answerWith([])
    const empty = await live(LINE)
    upstreamAnsweringNothing()
    const failed = await live('NO_SUCH_LINE_999')

    expect(empty.statusCode, empty.body).toBe(200)
    expect(failed.statusCode, failed.body).toBe(404)
    expect(empty.statusCode).not.toBe(failed.statusCode)
    expect(Array.isArray(empty.json().data?.buses), 'the answered read carries the list').toBe(true)
    expect(failed.json().data, 'the failed read carries nothing list-shaped').toBeUndefined()
  })

  it('刷新的三种回应各有状态码：答了 200、什么都没读 429、读了而都没答 502', async () => {
    const user = 'fx-read-state-refresh'
    answerWith([{ busId: 'b1', order: 4, speed: 5, travels: [] }])

    const served = await refresh(user)
    expect(served.statusCode, served.body).toBe(200)
    expect(served.json().success, 'a served refresh is not a refused one').toBe(true)
    expect(served.json().data.throttled, 'nothing was throttled here').toBe(false)
    expect(typeof served.json().data.lines[0].lastUpdatedAt, 'a served refresh carries the instant it obtained')
      .toBe('number')

    // 同一个用户的下一次立刻到来：冷却窗口什么都没读就拒绝了它。
    const throttled = await refresh(user)
    expect(throttled.statusCode, `the second immediate refresh was answered as a reading: ${throttled.body}`).toBe(429)
    expect(throttled.headers['retry-after'], 'the refusal must say when to try again').toBeDefined()
    expect(throttled.json().data.throttled, 'the refused refresh is marked as such').toBe(true)

    // 换一个用户（新的窗口），并让上游这次完全不答。
    upstreamAnsweringNothing()
    const unread = await refresh(`${user}-unread`)
    expect(unread.statusCode, `a refresh nobody answered was served as a reading: ${unread.body}`).toBe(502)
    expect(unread.json().success).toBe(false)
    expect(typeof unread.json().error).toBe('string')
    // 什么都没取到时，最新时刻仍是 null —— 作答的时刻不是读数。
    expect(unread.json().data.lastUpdatedAt, 'a clock was passed off as a reading').toBeNull()

    // 三种回应的状态码两两不同：没有任何两种会被同一个消费者读成同一种结局。
    expect(new Set([served.statusCode, throttled.statusCode, unread.statusCode]).size).toBe(3)
  })

  it('设置读取：确实为空是一个带状态的词，不是一个失败', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/transit/settings?userId=fx-read-state-never' })

    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.success, 'an empty read is not a failure').toBe(true)
    expect(body.error, 'an empty read must not carry a failure').toBeUndefined()
    expect(body.settingsState, 'the word that says which of the three this is').toBe('unset')
    expect(body.data, 'an empty answer carries nothing a consumer could print').toBeNull()
    // 还会传出去的默认值就是某个界面会当成使用者自己的配置印出来的默认值。
    for (const invented of ['06:30', '11:30', '17:00', '22:00']) {
      expect(res.body.includes(invented), `the unset answer carries ${invented}`).toBe(false)
    }
  })

  it('设置读取：读到了是同一个接口的另一个词，值本身与空答案不同', async () => {
    const user = 'fx-read-state-stored'
    const saved = await api.inject({
      method: 'PATCH',
      url: `/api/transit/settings?userId=${user}`,
      payload: { morningStart: '07:15', morningEnd: '08:45' },
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const body = (await api.inject({ method: 'GET', url: `/api/transit/settings?userId=${user}` })).json()
    expect(body.settingsState, 'a stored row must not be reported as empty').toBe('stored')
    expect(body.data).not.toBeNull()
    expect(body.data).toMatchObject({ morningStart: '07:15', morningEnd: '08:45' })
  })
})
