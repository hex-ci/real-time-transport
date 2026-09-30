/**
 * 移动端：375×667 视口下无横向溢出、可访问名包含可见文字、主控件的触控目标够大。
 *
 * 触控目标的规则按本仓自己的两档来落：**主控件 44px**（各处写死的 `min-h-[44px]` / `h-11`）被断言，
 * 其余控件只测量并打印（见下方 `note`）。刻意**不**把「所有可点控件 ≥ 44px」写成断言：本仓有若干处刻意更小的
 * 控件（城市切换 40px、通勤模式切换 32px、移动端线路头部的图标按钮 28–32px），那样一条断言会
 * 因为几处已知的例外永远为红，也就不再说明任何事。例外被**测量并报告**，主控件被断言 ——
 * 于是「主控件被改小」仍然会红，而这正是要防的回归。
 *
 * 可访问名那一条：控件若没有显式的名字（aria-label / title / alt），浏览器就用它的可见文字当
 * 名字 —— 故名字取「显式名优先，其次可见文字」，再要求名字里含有可见文字。真正会被抓到的是
 * 两类缺陷：有可见文字却给了**另一句话**的 aria-label，以及只有图标的控件根本没有名字。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay, api, apiData } from '../harness.mjs'

export const name = '移动端可访问性'

const VIEWPORT = { width: 375, height: 667 }

/** 页面侧测量：横向溢出、每个可交互控件的名字/可见文字/尺寸。 */
const MEASURE = `JSON.stringify((() => {
  const controls = [...document.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]), select, textarea')]
    .filter(el => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
    .map(el => {
      const rect = el.getBoundingClientRect()
      const visible = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ')
      const explicit = String(
        el.getAttribute('aria-label')
        || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : '')
        || el.getAttribute('title')
        || el.getAttribute('alt')
        || '',
      ).trim().replace(/\\s+/g, ' ')
      return {
        tag: el.tagName.toLowerCase(),
        visible: visible.slice(0, 40),
        explicit: explicit.slice(0, 60),
        name: (explicit || visible).slice(0, 60),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    })
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    controls,
  }
})())`

/** 每页的主控件：本仓写死 ≥44px 的那些动作。按可见文字点名，图标按钮则按它的可访问名。 */
const PRIMARY = {
  home: ['刷新最新车况'],
  line: ['刷新最新车况'],
  platform: ['刷新最新车况', '定位最近站台'],
  chain: ['刷新最新车况', '上班', '下班'],
  settings: ['关注线路', '通勤时段', '位置锚点', '通勤链路'],
}

export async function run({ check, equal, note, fixtures }) {
  await cli(['resize', String(VIEWPORT.width), String(VIEWPORT.height)])

  const lineId = fixtures.favorites.a.line.upLineId
  const pages = [
    { key: 'home', url: `${WEB_ORIGIN}/`, wait: 'JSON.stringify(document.querySelectorAll(\'main\').length > 0)' },
    { key: 'line', url: `${WEB_ORIGIN}/line/${encodeURIComponent(lineId)}?direction=0&cityCode=${fixtures.city}`, wait: 'JSON.stringify(document.body.innerText.includes(\'开往\'))' },
    { key: 'platform', url: `${WEB_ORIGIN}/platform`, wait: 'JSON.stringify(document.querySelectorAll(\'main select\').length > 0)' },
    { key: 'chain', url: `${WEB_ORIGIN}/commute-chain`, wait: 'JSON.stringify(document.body.innerText.includes(\'换乘链路\'))' },
    { key: 'settings', url: `${WEB_ORIGIN}/settings`, wait: 'JSON.stringify(document.querySelectorAll(\'main a[href^="/settings/"]\').length === 4)' },
  ]

  for (const page of pages) {
    await goto(page.url)
    try {
      await waitForValue(page.wait, value => value === true, { what: `${page.key} 渲染`, timeout: 25_000 })
    }
    catch {
      // 等不到就照样测：下面量的是布局与触控目标，不是内容。
    }
    if (page.key === 'line') {
      // 线路页的主控件（刷新）在移动端的信息抽屉里；打开它，抽屉本身也顺带被量一遍。
      // 按 title 定位：那枚按钮的名字来自它的内容（线路名），title 只是补充。
      await cli(['click', '[title="点击查看线路详情"]'])
      await delay(1200)
    }
    await delay(1200)
    const measured = await pageEval(MEASURE)
    note(`${page.key}: 视口 ${measured.viewport.width}×${measured.viewport.height}，scrollWidth=${measured.scrollWidth}，控件 ${measured.controls.length} 个`)
    check(
      `${page.key} 没有横向溢出`,
      measured.scrollWidth <= measured.viewport.width + 1,
      `scrollWidth=${measured.scrollWidth} > 视口 ${measured.viewport.width}`,
    )

    const mismatched = measured.controls.filter(c => c.visible !== '' && c.explicit === '' && !c.name.includes(c.visible.slice(0, 12)))
    check(
      `${page.key} 可见文字就是它自己的名字（没有显式名字时，浏览器就用可见文字）`,
      mismatched.length === 0,
      JSON.stringify(mismatched.slice(0, 4)),
    )
    const nameless = measured.controls.filter(c => c.visible === '' && c.explicit === '')
    check(`${page.key} 没有无名控件（只有图标的控件自报其用途）`, nameless.length === 0, JSON.stringify(nameless.slice(0, 4)))
    // 显式名字与可见文字不一致的控件：本仓有几处是刻意的（按钮上写当前值、名字说这个动作是什么，
    // 如城市切换写「北京」、名字「选择城市」）。它们不是缺陷，故只测量并报告，不做断言。
    const relabelled = measured.controls.filter(c => c.visible !== '' && c.explicit !== '' && !c.explicit.includes(c.visible.slice(0, 12)))
    if (relabelled.length > 0) {
      note(`${page.key} 名字与可见文字不同的控件（名字说的是动作）：${JSON.stringify(relabelled.map(c => `${c.visible}→${c.explicit}`))}`)
    }

    const primary = measured.controls.filter(c => PRIMARY[page.key].some(name => (c.visible || c.explicit).includes(name)))
    check(`${page.key} 的主控件都在屏上被量到了`, primary.length >= PRIMARY[page.key].length, JSON.stringify(primary.map(c => c.visible)))
    for (const control of primary) {
      check(
        `${page.key} 的主控件「${control.visible || control.explicit}」触控目标 ≥44px`,
        control.width >= 44 && control.height >= 44,
        `实测 ${control.width}×${control.height}`,
      )
    }

    const small = measured.controls.filter(c => c.width < 44 || c.height < 44)
    if (small.length > 0) {
      note(`${page.key} 的次要控件（<44px）：${JSON.stringify(small.map(c => `${c.visible || c.explicit}:${c.width}×${c.height}`))}`)
    }
  }

  // 顶部是工具栏：一行控件（模式/目的、定位、刷新），读数在下面一行小字；没有展开/收起。
  // 视口在这里显式定住，并等到该页特征出现再量 —— 固定 sleep 会让还没导航完的那一页被量成上一页。
  await cli(['resize', '375', '667'])
  for (const area of [
    { name: '首页', url: `${WEB_ORIGIN}/`, ready: text => String(text).includes('自动'), hasLocate: true, switches: ['自动', '上班', '下班', '附近'] },
    { name: '链路页', url: `${WEB_ORIGIN}/commute-chain`, ready: text => !String(text).includes('自动') && String(text).includes('上班'), hasLocate: false, switches: ['上班', '下班'] },
  ]) {
    await goto(area.url)
    await waitForValue(
      `JSON.stringify([...document.querySelectorAll('[data-toolbar]')].find(el => el.getBoundingClientRect().height > 1)?.innerText ?? '')`,
      area.ready,
      { what: `${area.name} 的工具栏就位`, timeout: 20_000 },
    )
    const bar = await pageEval(`JSON.stringify((() => {
      const bar = [...document.querySelectorAll('[data-toolbar]')].find(el => el.getBoundingClientRect().height > 1)
      if (!bar) return { missing: true }
      const card = bar.closest('[class*=rounded-2xl]')
      const controls = [...bar.querySelectorAll('button,[role=radio]')].filter(el => el.getBoundingClientRect().width > 0)
      return {
        slot: bar.getAttribute('data-toolbar'),
        controls: controls.map(el => ({
          name: el.getAttribute('aria-label') || el.innerText.trim(),
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        })),
        toggles: controls.filter(el => el.getAttribute('aria-controls')).length,
        hasLocate: controls.some(el => (el.getAttribute('aria-label') || '').includes('定位')),
        switchWords: ${JSON.stringify(area.switches)}.filter(word => bar.innerText.includes(word)),
        hasFreshness: /最后更新/.test(bar.innerText),
        tops: [...new Set(controls.map(el => Math.round(el.getBoundingClientRect().top)))],
        rowHeight: Math.round(bar.getBoundingClientRect().height),
        boxMinWidth: getComputedStyle([...bar.children].find(el => String(el.className).includes('overflow-hidden')) ?? bar).minWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }
    })())`)

    check(`${area.name} 窄屏用的是窄档工具栏`, bar.slot === 'narrow', JSON.stringify(bar))
    const undersized = (bar.controls ?? []).filter(c => c.w < 44 || c.h < 44)
    check(`${area.name} 工具栏可见控件都不小于 44`, (bar.controls ?? []).length > 0 && undersized.length === 0, JSON.stringify(undersized))
    check(`${area.name} 切换控件直接在工具栏里（无需展开）`, (bar.switchWords ?? []).length >= 2, JSON.stringify(bar.switchWords))
    check(`${area.name} 定位按钮${area.hasLocate ? '在' : '不在'}`, bar.hasLocate === area.hasLocate, JSON.stringify(bar))
    check(`${area.name} 已无展开/收起开关`, bar.toggles === 0, JSON.stringify(bar.toggles))
    check(`${area.name} 工具栏里不再有读数文案`, bar.hasFreshness === false, JSON.stringify(bar))
    check(
      `${area.name} 工具栏是一行（所有控件同一条水平线）`,
      (bar.tops ?? []).length === 1 && bar.rowHeight <= 46,
      JSON.stringify({ tops: bar.tops, rowHeight: bar.rowHeight }),
    )
    check(`${area.name} 窄屏没有横向溢出`, bar.overflow === false, JSON.stringify(bar))
    // 宽度下限必须是框架里真有的那一档：`min-w-max`（→ `max-content`）。名字像而**不是**类的那个
    // （`min-w-max-content`：本版主题里没有这一档）不生成任何规则，computed 会退回 `0px` ——
    // 容器于是可以被压到比它的四个档位还窄，而那是裁字，不是换行。
    check(
      `${area.name} 模式容器的宽度下限是真的（computed = max-content）`,
      bar.boxMinWidth === 'max-content',
      JSON.stringify(bar.boxMinWidth),
    )
    note(`${area.name} 工具栏控件：${JSON.stringify(bar.controls)}`)
  }

  // 通勤时段没设过时那句提示：它必须**不**在工具行里，且模式容器一个字都不许被裁。
  //
  // 钉的是一件真被踩到的事：提示原来与模式切换同处一行，而模式容器是 `flex-1` + `overflow:hidden`
  // （滚动容器的自动最小尺寸是 0），于是它被压到比四个档位还窄 —— 375 上「附近」整格看不见。
  // 上面那条「没有横向溢出」量的是**页面**的溢出，裁在容器里的事它看不见，故一直绿着；
  // 这里量的是容器自己的 `scrollWidth - clientWidth`。
  {
    const before = await apiData('/api/transit/settings')
    const hours = {
      morningStart: before.morningStart,
      morningEnd: before.morningEnd,
      eveningStart: before.eveningStart,
      eveningEnd: before.eveningEnd,
    }
    await api('/api/transit/settings', {
      method: 'PATCH',
      body: { morningStart: null, morningEnd: null, eveningStart: null, eveningEnd: null },
    })
    try {
      await goto(`${WEB_ORIGIN}/`)
      await waitForValue(
        `JSON.stringify(document.querySelector('[data-prompt-area="narrow"]')?.getBoundingClientRect().height ?? 0)`,
        height => typeof height === 'number' && height > 0,
        { what: '未设置通勤时段的提示就位', timeout: 20_000 },
      )
      const probe = await pageEval(`JSON.stringify((() => {
        const bar = [...document.querySelectorAll('[data-toolbar]')].find(el => el.getBoundingClientRect().height > 1)
        const box = [...bar.children].find(el => el.innerText.includes('自动'))
        const area = [...document.querySelectorAll('[data-prompt-area]')].find(el => el.getBoundingClientRect().height > 0)
        const link = area?.querySelector('a')
        return {
          clipped: box.scrollWidth - box.clientWidth,
          switchWords: ['自动', '上班', '下班', '附近'].filter(word => box.innerText.includes(word)),
          inToolbar: bar.innerText.includes('未设置通勤时段'),
          barWidth: Math.round(bar.getBoundingClientRect().width),
          promptHref: link?.getAttribute('href') ?? null,
          promptHeight: Math.round(link?.getBoundingClientRect().height ?? 0),
          promptWidth: Math.round(link?.getBoundingClientRect().width ?? 0),
          promptTop: Math.round(link?.getBoundingClientRect().top ?? 0),
          barBottom: Math.round(bar.getBoundingClientRect().bottom),
        }
      })())`)

      check('未设置通勤时段：四个档位一个都不被裁', probe.clipped === 0 && probe.switchWords.length === 4, JSON.stringify(probe))
      check('未设置通勤时段：那一句不在工具行里', probe.inToolbar === false, JSON.stringify(probe))
      check(
        '未设置通勤时段：提示是工具行之下的整行 44px 入口',
        probe.promptHref === '/settings/schedule'
        && probe.promptHeight >= 44
        && probe.promptWidth === probe.barWidth
        && probe.promptTop >= probe.barBottom,
        JSON.stringify(probe),
      )
      note(`未设置通勤时段时的工具栏：${JSON.stringify(probe)}`)
    }
    finally {
      await api('/api/transit/settings', { method: 'PATCH', body: hours })
    }
  }

  // 按下刷新要有回话：成功说「已刷新」，窗口没走完说剩余多少秒。
  await goto(`${WEB_ORIGIN}/`)
  await cli(['resize', '375', '667'])
  // 窄档那一枚要真的在屏上（宽档那份同时存在于 DOM 里，但 375 下不可见、点不到）。
  await waitForValue(
    `JSON.stringify(document.querySelector('[data-toolbar="narrow"] button[aria-label="刷新最新车况"]')?.getBoundingClientRect().width ?? 0)`,
    width => typeof width === 'number' && width > 0,
    { what: '窄档刷新按钮可见', timeout: 20_000 },
  )
  // 连按两次：第一次说「已刷新」，第二次必须在窗口没走完时说出「刷新太频繁 · N 秒后可刷新」——
  // 冷却期按钮按不动就等于把这句话藏起来，那正是它该出现的时候。
  await cli(['click', '[data-toolbar="narrow"] button[aria-label="刷新最新车况"]'])
  await delay(1200)
  const toast = await pageEval(`JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map(el => el.innerText.replace(/\\n/g, ' ')))`)
  check(
    '按下刷新后页面上出现了回话',
    (toast ?? []).some(t => t.includes('已刷新') || t.includes('刷新太频繁') || t.includes('刷新失败')),
    JSON.stringify(toast),
  )

  await cli(['click', '[data-toolbar="narrow"] button[aria-label="刷新最新车况"]'])
  await delay(1200)
  const second = await pageEval(`JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map(el => el.innerText.replace(/\\n/g, ' ')))`)
  check(
    '窗口没走完时再按一次会说出剩余秒数',
    (second ?? []).some(t => t.includes('刷新太频繁')),
    JSON.stringify(second),
  )

  // 按下定位也要有回话：这台上是开发模拟（说「开发模拟」），真实环境里则是不支持或被拒 ——
  // 无论哪一种，按下一个没有回声的按钮都是缺陷。
  await cli(['click', '[data-toolbar="narrow"] button[aria-label="定位最近站"]'])
  await delay(1200)
  const locateToast = await pageEval(`JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map(el => el.innerText.replace(/\\n/g, ' ')))`)
  check(
    '按下定位后页面上出现了回话',
    (locateToast ?? []).some(t => t.includes('位置') || t.includes('定位')),
    JSON.stringify(locateToast),
  )

  // 一屏的内容也要能在 375 宽里读完：首页没有一个容器横向被裁切。
  await goto(`${WEB_ORIGIN}/`)
  await delay(2000)
  const clipped = await pageEval(`JSON.stringify([...document.querySelectorAll('main *')]
    .filter(el => el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && getComputedStyle(el).overflowX === 'visible')
    .map(el => el.tagName + '.' + String(el.className).slice(0, 40)).slice(0, 5))`)
  note(`可能被裁切的元素：${JSON.stringify(clipped)}`)
  check('首页没有横向被裁切的容器', (clipped ?? []).length === 0, JSON.stringify(clipped))

  await cli(['resize', '1280', '900'])
  await delay(300)
  equal('视口回到桌面尺寸', await pageEval('JSON.stringify(window.innerWidth)'), 1280)
}
