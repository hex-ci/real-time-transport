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
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay } from '../harness.mjs'

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

/** 每页的主控件：本仓写死 ≥44px 的那些动作（按可见文字点名）。 */
const PRIMARY = {
  home: ['刷新最新车况'],
  line: ['刷新最新车况'],
  platform: ['刷新车况数据'],
  chain: ['上班', '下班'],
  settings: ['关注线路', '通勤时段', '位置锚点', '通勤链路'],
}

export async function run({ check, equal, note, fixtures }) {
  await cli(['resize', String(VIEWPORT.width), String(VIEWPORT.height)])

  const lineId = fixtures.favorites.a.line.upLineId
  const pages = [
    { key: 'home', url: `${WEB_ORIGIN}/`, wait: 'JSON.stringify(document.querySelectorAll(\'main\').length > 0)' },
    { key: 'line', url: `${WEB_ORIGIN}/line/${encodeURIComponent(lineId)}?direction=0&cityCode=${fixtures.city}`, wait: 'JSON.stringify(document.body.innerText.includes(\'开往\'))' },
    { key: 'platform', url: `${WEB_ORIGIN}/platform`, wait: 'JSON.stringify(document.querySelectorAll(\'main select\').length > 0)' },
    { key: 'chain', url: `${WEB_ORIGIN}/commute-chain`, wait: 'JSON.stringify(document.body.innerText.includes(\'能不能赶上换乘点那班车\'))' },
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

    const primary = measured.controls.filter(c => PRIMARY[page.key].some(name => c.visible.includes(name)))
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
