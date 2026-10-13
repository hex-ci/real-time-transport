import { afterEach, describe, expect, it, vi } from 'vitest'
import { h, type Ref } from 'vue'
import {
  click,
  mountComponent,
  type MountedHost,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import StationBoardPage from '../../../views/station-board/index.vue'

/**
 * 列表的**重建时机**：定位抖一抖不重排，真的走开才重排，而下拉开着时一律推迟。
 *
 * 这一条只有把定位换成可控的桩才证得出来：真定位流每一下都在动，而这一页的站台彼此常只差
 * 几十米 —— 按每一下读数重排，顺序就会在读的人手指底下跳（真浏览器里实测过：六次 20~40 米的
 * 抖动，顺序六次全变）。
 *
 * 桩件的契约与真 store 一致：`userCoords` 是换算到站表那个面上的那份（测距用它），
 * `deviceFix` 是浏览器报的原始定位（门槛量的是它）。
 */

/** 测试所在的位置（`vi.hoisted`：桩件工厂在 import 期就要用它）。 */
const DEVICE = vi.hoisted(() => ({ lat: 39.9042, lng: 116.4074 }))

/**
 * 可控的定位桩：改这三个 ref 就等于人挪了地方。
 *
 * 用 `reactive` 包一层，与 Pinia 暴露 store 的方式一致 —— **属性读到的必须是值**，
 * 直接给出 ref 会让页面拿到一个对象本体（距离因此算成 NaN，顺序看起来「没变」，
 * 而那是桩件的缺陷在冒充被测行为）。
 */
vi.mock('@/stores/location.store', async () => {
  const { reactive, ref } = await import('vue')
  const deviceFix = ref<{ lat: number, lng: number } | null>({ ...DEVICE })
  const userCoords = ref<{ lat: number, lng: number } | null>({ ...DEVICE })
  const accuracyM = ref<number | null>(null)
  const store = reactive({
    deviceFix,
    userCoords,
    accuracyM,
    requestLocation: () => {},
    stopLocation: () => {},
  })
  return { useLocationStore: () => store, __locationStub: { deviceFix, userCoords, accuracyM } }
})

/** 桩件自己的那三个 ref（测试改它们就等于人挪了地方）。 */
const stub = (await import('@/stores/location.store') as unknown as {
  __locationStub: {
    deviceFix: Ref<{ lat: number, lng: number } | null>
    userCoords: Ref<{ lat: number, lng: number } | null>
    accuracyM: Ref<number | null>
  }
}).__locationStub

/** 下拉桩件：把候选按屏上顺序渲染出来，并给测试一个开合面板的按钮（真键盘由 e2e 钉）。 */
vi.mock('@/components/searchable-combobox', () => ({
  SearchableCombobox: {
    name: 'SearchableComboboxStub',
    props: ['modelValue', 'label', 'options', 'selected', 'placeholder'],
    emits: ['select', 'update:modelValue', 'update:open'],
    // 自己记着开合：真组件用 reka 的 `v-model:open`，这里一个按钮按一下翻一次。
    data: () => ({ open: false }),
    render(this: { options?: unknown, open: boolean }) {
      const options = (this.options ?? []) as Array<{ primary: string, secondary: string | null }>
      const self = this as unknown as { $emit: (e: string, ...args: unknown[]) => void, open: boolean }
      return h('div', { 'data-stub': 'combobox' }, [
        h('button', {
          'data-stub': 'toggle',
          'onClick': () => {
            self.open = !self.open
            self.$emit('update:open', self.open)
          },
        }, '开合'),
        ...options.map(option => h('span', { 'data-stub': 'option' }, `${option.primary} ${option.secondary ?? ''}`)),
      ])
    },
  },
}))

const CITY = '027'
/** 读取时刻：板子的「最后更新」由它推出来。 */
const READ_AT = new Date('2026-10-12T08:30:00').getTime()

/**
 * 三个站：两个来自关注线路的站表（甲、乙在东边约 85 与 255 米），一个来自附近的站台（丙，约 220 米）。
 *
 * 走开 400 米（向东）之后三者的先后整批换人 —— 这正是「重排有没有发生」看得见的地方。
 */
const STOPS = [
  { id: '010-00001', name: 'NN甲站', lng: DEVICE.lng + 0.001 },
  { id: '010-00002', name: 'NN乙站', lng: DEVICE.lng + 0.003 },
]

function favourite(): Record<string, unknown> {
  return {
    id: 'fav-1',
    userId: 'default_user',
    cityCode: CITY,
    lineId: 'bus_027_1',
    reverseLineId: 'bus_027_2',
    lineName: '101路',
    preferredDirection: 0,
    displayOrder: 0,
  }
}

function routes(): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [favourite()] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: CITY, name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/lines\//, () => ({
      success: true,
      data: {
        lineId: 'bus_027_1',
        lineName: '101路',
        direction: 0,
        stops: STOPS.map((stop, index) => ({ id: stop.id, name: stop.name, order: index + 1, interchanges: [], lat: DEVICE.lat, lng: stop.lng })),
      },
    })],
    [/\/api\/transit\/stations\/nearby/, () => ({
      success: true,
      data: [{ stationId: '010-00003', name: 'NN丙站', lat: DEVICE.lat, lng: DEVICE.lng + 0.0026 }],
    })],
    [/\/api\/transit\/stations\/.*\/board/, () => ({
      success: true,
      data: {
        dataClass: 'live',
        throttled: false,
        lastUpdatedAt: READ_AT,
        nextAllowedAt: READ_AT + 18_000,
        retryAfterSeconds: 18,
        lines: [],
      },
    })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
  ]
}

/** 屏幕上的候选顺序（桩件按数组顺序渲染，故读到的就是列表自己的顺序）。 */
function optionOrder(host: MountedHost): string[] {
  return host.nodes(item => item.props['data-stub'] === 'option').map(node => host.textOf(node).trim())
}

/** 面板开着没有：桩件自己记着，测试用它开合。 */
function panelToggle(host: MountedHost) {
  return host.node(item => item.props['data-stub'] === 'toggle', '面板开合按钮')
}

async function mountBoard(): Promise<MountedHost> {
  stub.deviceFix.value = { ...DEVICE }
  stub.userCoords.value = { ...DEVICE }
  stub.accuracyM.value = null
  const host = await mountComponent(StationBoardPage, { routes: routes() })
  await host.flush()
  return host
}

/** 人挪到相对 DEVICE 的偏移处（米）；`deviceFix` 与 `userCoords` 一起动，与真 store 一致。 */
function moveTo(dNorth: number, dEast: number): void {
  const lat = DEVICE.lat + dNorth / 111320
  const lng = DEVICE.lng + dEast / (111320 * Math.cos(DEVICE.lat * Math.PI / 180))
  stub.deviceFix.value = { lat, lng }
  stub.userCoords.value = { lat, lng }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('列表什么时候重建', () => {
  it('定位在几十米里打转：顺序不为所动（列表是一次快照）', async () => {
    const host = await mountBoard()
    const before = optionOrder(host)
    expect(before.length, '候选没渲染出来，后面的断言就没在看东西').toBeGreaterThan(1)

    const drifts: Array<[number, number]> = [[12, -18], [-25, 9], [31, 22], [-14, -33], [8, 41]]
    for (const [dNorth, dEast] of drifts) {
      moveTo(dNorth, dEast)
      await host.flush()
      expect(optionOrder(host), `挪 ${dNorth},${dEast} 米`).toEqual(before)
    }
    host.unmount()
  })

  it('真的走开了（400 米）：重排，并重取一次附近的站台', async () => {
    const host = await mountBoard()
    const before = optionOrder(host)
    const nearbyCalls = () => host.server.seen(/\/api\/transit\/stations\/nearby/).length

    moveTo(0, 400)
    await host.flush()
    await host.flush()

    expect(optionOrder(host)).not.toEqual(before)
    expect(nearbyCalls()).toBeGreaterThan(0)
    host.unmount()
  })

  it('门槛被设备自己声明的精度抬起来：±200 米的定位，150 米不算走开', async () => {
    const host = await mountBoard()
    stub.accuracyM.value = 200
    const before = optionOrder(host)

    moveTo(0, 150)
    await host.flush()

    expect(optionOrder(host)).toEqual(before)
    host.unmount()
  })

  it('下拉开着的时候走开：不重排（也不重取），关上之后才补上', async () => {
    const host = await mountBoard()
    const before = optionOrder(host)
    const nearbyCalls = () => host.server.seen(/\/api\/transit\/stations\/nearby/).length

    // 打开面板，然后走开 400 米。
    click(panelToggle(host))
    await host.flush()
    const callsWhileOpen = nearbyCalls()
    moveTo(0, 400)
    await host.flush()
    await host.flush()

    // 列表正被人读着：顺序不动，也不去打扰上游。
    expect(optionOrder(host)).toEqual(before)
    expect(nearbyCalls()).toBe(callsWhileOpen)

    // 关上：攒下的那一次重排补上。
    click(panelToggle(host))
    await host.flush()
    await host.flush()

    expect(optionOrder(host)).not.toEqual(before)
    host.unmount()
  })
})
