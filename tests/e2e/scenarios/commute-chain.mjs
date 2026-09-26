/**
 * 通勤链路页：每段的余量与结论、按目的筛选、首次进入跟随通勤时段。
 *
 * 断言对着**页面自己收到的那一份应答**比（fetch 记录器抓住的 deductions 响应），而不是测试再问一次：
 * 模拟读数每次读都不同，重问一次就会拿另一个时刻的数字去比屏幕，那是在比两件事。
 *
 * 默认页签那一条不靠系统时钟碰运气：把「覆盖此刻的那个时段」在早/晚之间挪一下，
 * 页面选中的页签就必须跟着挪 —— 这一条在任何钟点都能跑。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay, recordedRequests, installFetchRecorder, clearRecordedRequests } from '../harness.mjs'
import { setSettings, windowCoveringNow, windowAwayFromNow, deductions } from '../fixtures.mjs'

export const name = '通勤链路页'

/** 档位的词表：与 `MARGIN_BAND_COPY` 同一份（页面照它措辞）。 */
const COPY = {
  comfortable: { label: '充裕', verdict: '赶得上 · 就是这班' },
  tight: { label: '紧', verdict: '赶得上 · 就这几分钟' },
  uncertain: { label: '不确定', verdict: '赶不赶得上，看是不是正好这一班' },
  insufficient: { label: '不足', verdict: '赶不上出门时的那班 · 实际是下一班' },
}

/** 与 `chainMarginBandOf` 同一条规则（1 分钟是它自己的分辨率，3 分钟是容忍值）。 */
function bandOf(marginMinutes) {
  if (Math.abs(marginMinutes) < 1) return 'uncertain'
  if (marginMinutes < 0) return 'insufficient'
  return marginMinutes <= 3 ? 'tight' : 'comfortable'
}

const CARD_TEXTS = `JSON.stringify([...document.querySelectorAll('main article')].map(card => card.innerText))`

/** 页面自己收到的那一份链路应答。 */
async function chainFeed() {
  const entries = (await recordedRequests()).filter(r => r.url.includes('/commute-chains/deductions'))
  const last = entries[entries.length - 1]
  return { purpose: /purpose=(\w+)/.exec(last?.url ?? '')?.[1] ?? null, body: last?.response?.data ?? null }
}

/** 诊断用：记到的每一次请求，以及它们的应答有没有被解析出来。 */
async function recordedSummary() {
  return (await recordedRequests()).map(r => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 70)} → ${r.status ?? '?'} ${r.response ? 'json' : 'no-json'}`)
}

export async function run({ check, equal, note, fixtures }) {
  const morningChain = fixtures.chains.morning

  await installFetchRecorder()
  await goto(`${WEB_ORIGIN}/commute-chain`)
  await waitForValue(
    CARD_TEXTS,
    cards => Array.isArray(cards) && cards.length > 0 && cards.join('').includes(morningChain.name),
    { what: '链路卡片渲染出来', timeout: 30_000 },
  )

  // ---- 首次进入的默认页签跟随通勤时段（此刻在早通勤时段里）------------------------
  const feed = await chainFeed()
  equal('页面按通勤时段请求了上班目的的链路', feed.purpose, 'morning')
  const checked = await pageEval(`JSON.stringify([...document.querySelectorAll('[role=radio]')]
    .filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.textContent.trim()))`)
  equal('上班页签被选中', checked, ['上班'])
  const defaultLine = await pageEval(`JSON.stringify(document.getElementById('purpose-default')?.textContent ?? null)`)
  check('页面说明默认是跟随时段选定的', String(defaultLine).includes('默认按通勤时段选定：上班'), `实际 ${JSON.stringify(defaultLine)}`)

  // ---- 每段的余量与结论 ---------------------------------------------------------
  note(`页面收到的请求：${JSON.stringify(await recordedSummary())}`)
  const deduction = feed.body?.chains?.find(c => c.chainId === morningChain.id)?.deduction
  check('这一条链路真的推演出了结论（夹具前置条件）', deduction?.status === 'deduced', JSON.stringify(deduction))
  note(`链路的载荷：${JSON.stringify(deduction)}`)

  if (deduction?.status === 'deduced') {
    const cardText = (await pageEval(CARD_TEXTS)).find(text => text.includes(morningChain.name)) ?? ''
    const chainCopy = COPY[deduction.band]
    check('链路卡片印出它自己的档位词', cardText.includes(chainCopy.label), `载荷档位 ${deduction.band}（${chainCopy.label}），卡片：${JSON.stringify(cardText)}`)
    check('链路卡片给出结论那一句', cardText.includes(chainCopy.verdict), `期望「${chainCopy.verdict}」`)
    check(
      '链路点出最紧的那一段',
      cardText.includes(`最紧的是第 ${deduction.bindingSeq + 1} 段`),
      `载荷 bindingSeq=${deduction.bindingSeq}`,
    )
    const chainMarginShown = deduction.band !== 'insufficient' && deduction.marginMinutes >= 0
    check(
      chainMarginShown ? '链路印出余量分钟' : '余量为负/不足时不印数字',
      chainMarginShown ? cardText.includes(`余量 ${deduction.marginMinutes} 分`) : !/余量 -?\d+ 分/.test(cardText),
      `载荷 marginMinutes=${deduction.marginMinutes}，卡片：${JSON.stringify(cardText)}`,
    )

    for (const leg of deduction.legs) {
      const referenceGone = leg.referenceVehicleId !== leg.vehicleId || leg.marginMinutes < 0
      const band = referenceGone ? 'insufficient' : bandOf(leg.marginMinutes)
      const legCopy = COPY[band]
      check(`第 ${leg.seq + 1} 段的档位词来自它自己的余量`, cardText.includes(legCopy.label), `载荷 margin=${leg.marginMinutes} → ${band}`)
      check(`第 ${leg.seq + 1} 段的结论句与档位一致`, cardText.includes(legCopy.verdict), `期望「${legCopy.verdict}」`)
      check(`第 ${leg.seq + 1} 段的站台等待来自载荷`, cardText.includes(`站台等待 ${leg.waitMinutes} 分`), `载荷 waitMinutes=${leg.waitMinutes}`)
      check(`第 ${leg.seq + 1} 段的车程来自载荷`, cardText.includes(`车程约 ${leg.rideMinutes} 分`), `载荷 rideMinutes=${leg.rideMinutes}`)
      check(`第 ${leg.seq + 1} 段的下车分钟来自载荷`, cardText.includes(`${leg.alightMinutes} 分钟后到下车站`), `载荷 alightMinutes=${leg.alightMinutes}`)
      check(
        referenceGone ? `第 ${leg.seq + 1} 段说改乘下一班且不印余量` : `第 ${leg.seq + 1} 段印出余量`,
        referenceGone
          ? cardText.includes('改乘下一班')
          : cardText.includes(`余量 ${leg.marginMinutes} 分`),
        `referenceVehicleId=${leg.referenceVehicleId} vehicleId=${leg.vehicleId} margin=${leg.marginMinutes}`,
      )
    }
  }

  // ---- 按目的筛选 ---------------------------------------------------------------
  await clearRecordedRequests()
  await cli(['click', `getByRole('radio', { name: '下班' })`])
  await waitForValue(
    CARD_TEXTS,
    cards => Array.isArray(cards) && cards.join('').includes(fixtures.chains.evening.name),
    { what: '下班目的下的链路', timeout: 25_000 },
  )
  const eveningFeed = await chainFeed()
  equal('切换页签后请求的是下班目的', eveningFeed.purpose, 'evening')
  const eveningCards = await pageEval(CARD_TEXTS)
  check('屏幕上只剩这个目的的链路', eveningCards.join('').includes(fixtures.chains.evening.name) && !eveningCards.join('').includes(morningChain.name), JSON.stringify(eveningCards))
  const serverEvening = await deductions('evening')
  equal('屏幕上显示的链路就是该目的端点答的那些', eveningCards.length, serverEvening.chains.length)

  // ---- 时段换到傍晚：默认页签跟着换 ---------------------------------------------
  const eveningWindow = windowCoveringNow()
  const morningAway = windowAwayFromNow()
  await setSettings({
    morningStart: morningAway.start,
    morningEnd: morningAway.end,
    eveningStart: eveningWindow.start,
    eveningEnd: eveningWindow.end,
  })
  await clearRecordedRequests()
  await goto(`${WEB_ORIGIN}/commute-chain`)
  await waitForValue(
    `JSON.stringify(document.getElementById('purpose-default')?.textContent ?? '')`,
    text => String(text).includes('默认按通勤时段选定：下班'),
    { what: '时段换到傍晚后页面说默认是下班', timeout: 25_000 },
  )
  const feedEvening = await chainFeed()
  equal('时段换到傍晚后默认请求的是下班目的', feedEvening.purpose, 'evening')
  const checkedEvening = await pageEval(`JSON.stringify([...document.querySelectorAll('[role=radio]')]
    .filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.textContent.trim()))`)
  equal('下班页签被选中', checkedEvening, ['下班'])

  // 复原成覆盖此刻的早时段，后面的场景（首页卡片）仍然要处在上班模式。
  const window = windowCoveringNow()
  const away = windowAwayFromNow()
  await setSettings({ morningStart: window.start, morningEnd: window.end, eveningStart: away.start, eveningEnd: away.end })
  await delay(200)
}
