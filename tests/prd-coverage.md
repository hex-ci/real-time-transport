# PRD 功能点覆盖矩阵（F1–F13）

**这份文件是断言，不是介绍。** 守卫 `apps/server/src/__tests__/prd-coverage.test.ts` 会解析
`docs/PRD.md` 里的每一个 `### F<n>` 编号，并断言它们都出现在本文件里 —— PRD 新增一个 F 而这里忘了
更新，守卫会变红。

层级（与 `tests/README.md` 同一套编号）：

| 层 | 命令 | 跑什么 |
|---|---|---|
| 0 静态 | `pnpm code-check` | typecheck + ESLint |
| 1 离线 | `pnpm test` | 全仓库单元 / 契约用例，服务端跑内存存储，不碰数据库 |
| 2 API/SQL | `pnpm test:db` → `pnpm test:api` | `app.inject()` 走 HTTP 边界，断言真的落在 SQL 上 |
| 3 浏览器 | `pnpm test:e2e` | 真实浏览器 e2e（本批次不在范围内） |

「怎么证」一列给的是**真能区分行为的断言**（改坏被测路径会红的那条），不是「它测了」这种话。
标「变异验证」的那些行，是被实际改坏过、确认会变红的（见文末）。

---

## F1 · 当前关注列表（核心）

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 上游不给分钟就不给数字（零假数据） | `api/x-no-fabricated-minute.test.ts` ·「上游没有发布到站时间的车：行还在，分钟与时刻都不在」 | 该行的 `minute`/`travelTimeSec` 字段**缺席**；正对照（有真分钟的车）字段存在 | 2 |
| `-1` 哨兵车与已过目标站的车不出现在到达行 | `api/f1-order-and-arrival-readings.test.ts` ·「到站行只收服务目标站的车」；`api/x-sentinel-single-parse.test.ts` ·「哨兵不印出数字：整个到达载荷里没有一个 -1」 | 列表不含哨兵车 id；整个载荷里没有 `-1` | 2 |
| `travelTimeSec 0` = 车在站台，不是「0 分钟」 | `api/f1-…` ·「来源声明车已在站台…按在站处理，并排在其它车之前」；`api/x-sentinel-single-parse` ·「上游的 travelTime 0 说的是车在站台上」 | `atPlatform` 标记为真 + 排首位，且不换算成分钟 | 2 |
| 多班次并列，不压缩成单一结论 | `api/f1-…` ·「没有上游到站时间的车仍然成行，但不给任何分钟」 | 同一列表里多行各自独立存在、各自分钟互不借用 | 2 |
| 「读不到」≠「没有车」 | `api/x-read-state-not-empty.test.ts` ·「确实为空…200 与一个说出线路名的空列表」/「读失败：上游没答 —— 拒绝，绝不是 200 与一个空列表」 | 状态码与形状不同（200+空列表 vs 拒绝） | 1+2 |
| 提示集中在信息卡内的提示位、工具行里没有提示；模式容器一个字都不被裁 | `web/__tests__/views/overview/top-area-toolbar.test.ts` ·「提示在场时工具行仍然装得下：那一句不在工具行里，故不动它的算术」「两档都只在没设过时出现，且它不在工具行里、是整行 44px 的入口」「375 上装得下这一行…」+ `tests/e2e/scenarios/mobile.mjs` ·「未设置通勤时段：四个档位一个都不被裁」「…那一句不在工具行里」「…提示是工具行之下的整行 44px 入口」「模式容器的宽度下限是真的（computed = max-content）」 | 容器自己的 `scrollWidth − clientWidth == 0`；computed `min-width == max-content`；提示在 `[data-prompt-area]` 内、宽度等于工具行宽、`top ≥ 工具行 bottom`；**变异验证**：把提示搬回工具行 → 两条位置断言红（`inToolbar=true`、提示宽 194 ≠ 329）；把 `min-w-max` 换回 `min-w-max-content` → computed 红（`auto`／`0px`） | 1+3 |
| **操作反馈只由提示说一次，页上不留第二处**；非操作反馈（读取失败、字段旁的本地校验）才用固定提示条 | `web/__tests__/action-feedback.test.ts` ·「被拒的原因跟在表里那句话后面，除非它只是同一件事换个说法」「每一页的推送点数目恰好是它自己的写操作数：切换与导航一个都不推」+ `web/__tests__/views/overview/action-feedback-overview.test.ts` ·「被拒：说一句置顶失败，并带上服务端给的原因」+ `web/__tests__/views/settings/action-feedback-writes.test.ts` ·「被拒：说一句未能保存」「被拒：说一句通勤时段保存失败」+ `web/__tests__/views/settings/anchor-place-search.test.ts` ·「保存失败留在这一页」「写库被拒」「用当前位置失败」+ `web/__tests__/views/settings/commute-chain-editor.test.ts` ·「把 400 的消息原样说一句，表单不关、列表不变」 | 每一次失败只推一句（`messages()` 恰好一条）且 `host.text()` 里**不含**那句原因；每页的推送出口数等于它的写操作数；`rejectionOf` 只丢「以失败收尾」的缺省句，服务端的成因整句要带上；**变异验证**：把内联加回去 → 对应断言红 | 1+2 |
| 首页卡片读失败不写成「暂无来车」 | `web/__tests__/views/overview/arrivals-read-wording.test.ts` ·「到站读取没答上来：说未读到，不说「前方暂无来车」」 | 文案分支按读取状态选 | 1 |
| 关注列表读失败 ≠ 一条都没关注 | `web/__tests__/views/overview/favourites-read-state.test.ts` ·「读失败时说「未读到关注线路」，不给「还没有关注线路」」 | 两种结局给出不同文案 | 1 |
| 参考行口径 `eta₁−walk ≤ T → 现在走`，否则给出门分钟 | `web/__tests__/reference-line.test.ts` ·「gives a departure time when there is slack to spare」「says leaving now still works, without instructing the user」「says the bus is gone when the walk outlasts it」 | 三种结论互不相同（`reads every verdict differently`） | 1 |
| 无锚点不给参考行（不用默认步行耗时） | `web/__tests__/reference-line.test.ts` ·「the reference line names an unsaved anchor instead of pricing a walk」 | 无锚点时指向设置页，**不**定价 | 1 |
| 参考行是辅助，不隐藏/压缩班次列表 | `web/__tests__/reference-line.test.ts` ·「renders the reference row once…」「places it after the arrivals it refers to」 | DOM 顺序 + 与班次列表互不影响 | 1 |

## F2 · 通勤起终点锚点

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 成对提交写成一行、读回同一对 | `api/f2-position-anchors.test.ts` ·「成对提交的锚点写成一行，读回来是同一对」 | 读回值等于写入值 | 2 |
| 成对的 `(0,0)` 被拒，且什么都没写 | `api/f2-…` ·「成对的 (0, 0) 被拒，且一个字段都没有写」；`api/x-sentinel-single-parse` ·「(0, 0) 的锚点对被拒在边界上，且一行都没落进存储」 | 400 + 存储零行 | 2 |
| 单轴为 0 是真实坐标，不是哨兵 | `api/f2-…` ·「单轴为 0 是真实坐标，照常写下来」；`api/x-sentinel-single-parse` ·「单轴为 0 是坐标而不是哨兵」 | 写入成功且落库 | 2 |
| 只给一个轴（或只清一个轴）被拒 | `api/f2-…` ·「只给一个轴（或只清一个轴）被拒」 | 400；成对 null 才清空 | 2 |
| WGS-84 只换算一次，站点坐标原样转发 | `api/f2-…` ·「原始 WGS-84 只换算一次」「GIS 边界：设备定位换算一次，站点坐标原样转发」 | 换算调用计数/入参 | 1+2 |
| 浏览器侧不做换算 | `web/__tests__/anchor-capture.test.ts` ·「returns the fix exactly as the browser reported it, converted by nobody」 | 浏览器上报值原样透传 | 1 |
| **搜索来源不换算**（`search` 的坐标已是 GCJ-02，原样落库） | `api/f2-anchor-source-and-place-search.test.ts` ·「搜索来的坐标原样落库：一次换算都不做」；`web/__tests__/views/settings/anchor-place-search.test.ts` ·「选了之后保存按钮可点，按下写一次库：坐标 + 名字 + 来源 search」 | 落库值**逐字等于**高德给的那一对（并断言它不等于换算一次的结果）；PATCH 体里 `homeAnchorSource === 'search'` 且坐标未被动过 | 1+2 |
| **地点名落库**（名字供界面认人，没有名字时显示坐标） | `api/f2-anchor-source-and-place-search.test.ts` ·「搜索来的坐标原样落库…」（`home_place_name` 逐字落库）·「设备路径把上一个搜索来的名字清掉」；`web/__tests__/views/settings/anchor-place-search.test.ts` ·「设备抓来的锚点没有名字：摘要显示坐标，不编造一个名字」 | 名字与坐标同行落库；设备路径写入后名字为 `null`；位置锚点索引页的两行对「有名字 / 没名字 / 没坐标」三种情形各说各的 | 1+2 |
| 地点搜索接口的三种结局分得开（空词 400 / 上游失败 502 / 答了没有匹配 200+空） | `api/f2-anchor-source-and-place-search.test.ts` ·「空 keywords → 400：空词不是「搜索全部」」「上游失败 → 502，不是「没有这个地方」」「上游答了但没有匹配 → 200 与空数组」 | 三种状态码与形状互不相同；且 400 时**没有**发出上游调用 | 2 |
| 早用「家」、晚用「公司」（方向由时段定） | `web/__tests__/reference-line.test.ts` ·「names 公司 for the evening leg」；`web/__tests__/views/commute-chain/chain-purpose-default.test.ts` ·「早上…默认上班」「傍晚…默认下班」 | 早晚两个锚点给出不同答案 | 1 |

## F3 · 收班与末班表达

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 三态各异：运营中 / 末班已过 / 首班之前 | `api/f3-operating-state.test.ts` ·「没有在途车时：有窗口是「运营中」，窗口之外是「末班车已过」—— 同一个空列表，两个答案」/「此刻在首班之前 → 首班车之前，并给出今天那一刻」 | **同一个空列表**给出两个不同状态 | 2 |
| 首末班读不到 → 未知，绝不默认运营中 | `api/f3-…` ·「首末班都读不到 → 未知，绝不默认成运营中」「只读到一端 → 未知，但已读到的那一端如实回报」「窗口终点不晚于起点 → 未知」 | 状态为「未知」而非「运营中」 | 2 |
| 三态文案各不相同 | `web/__tests__/operating-copy.test.ts` ·「says service has not started yet…」「says service has ended…」「reads every state differently」 | 三句文案两两不同 | 1 |
| 板面不再用含糊的「暂无来车」 | `web/__tests__/operating-copy.test.ts` ·「no longer answers the station board with a literal 「暂无来车」」 | 模板里不再出现该措辞 | 1 |
| 运营日模型（04:00 日界、跨零点尾班） | `packages/shared/src/__tests__/operating-state.test.ts` ·「is 已过末班 at 01:00 — the after-midnight tail belongs to the previous operating day」 | 凌晨 01:00 归属前一个运营日 | 1 |

## F4 · 数据可信度标记

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 三档词表恰为 live / schedule_simulation / exact_timetable | `packages/shared/src/__tests__/data-provenance.test.ts` ·「is exactly the three marks the product can produce」「no longer carries the kind with no producer」 | 词表集合精确相等 | 1 |
| 每行来源都在三档之内，没有已删的那一档 | `api/f4-data-provenance.test.ts` ·「每一行的来源都在三档词表内，没有一行是已删的那一档」 | 逐行断言落在集合内 | 2 |
| 无来源（未声明）不渲染任何标记，绝不取整为「实时」 | `api/f4-…` ·「没有上游到站时间的行不声明来源：未知绝不向「实时」取整」；`web/__tests__/data-provenance.test.ts` ·「shows nothing — never 实时 — when the provenance is not stated」 | 未声明 → 不渲染标记 | 1+2 |
| 生成车辆标「排班推演」，绝不标「实时」 | `api/f4-…` ·「生成车辆的到站行标为排班推演，绝不标成实时」 | 该行 provenance ≠ live | 2 |
| 已注册分钟级时刻表的站台标「精确时刻表」 | `api/f4-…` ·「已注册分钟级时刻表的站台标为精确时刻表」 | provenance == exact_timetable | 2 |
| 文字说明，不只靠颜色 | `web/__tests__/data-provenance.test.ts` ·「renders the vocabulary's three marks」「reads every kind differently」 | 三个 mark 有各自文字 | 1 |
| 站台行按各自来源标记，不靠路线类型/组件位置 | `web/__tests__/platform-provenance.test.ts` ·「never rounds an unclassifiable row up to the flattering mark」 | 不可分类行不被取整 | 1 |

## F5 · 站台聚合大屏

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 多线路聚合到同一站台：每行的分钟与车辆只来自它自己那条读数 | `api/f5-platform-aggregation.test.ts` ·「同一站台的多条线路各自成行：分钟与车辆只来自它自己那条线的读数」 | 两条线路在同一站序各读一次：对方的 `busId` 不出现在自己的载荷里，两边的分钟各自等于数据源给的那个 | 2 |
| 排序依据：分钟是**被请求的那一站**的价，不是线路末端的价 | `api/f5-…` ·「分钟是被请求的那一站的价：换一个站序读数，同一辆车给出另一行自己的数字」 | **变异验证**：聚合器 live 缓存键丢掉 `targetOrder` → 红（第二次读数重放第一次的 180） | 2 |
| 每行带各自的来源标记 | `api/f5-…` ·「一块屏上各行按各自的来源标记：实时读数与排班推演不是同一个标记」 | 两条线路的 `dataSource` 各不相同且都不缺失（`chelaile` / `subway_schedule`） | 2 |
| 「答了但没车」≠「读不到」 | `api/f5-…` ·「「答了但没车」与「读不到」不互相冒充：一块屏上两种结局的形状不同」 | 200 + 点名线路的空列表（仍带来源与时刻）vs 404 且连 `data` 都没有 | 2 |
| 最后更新跟着读数走 | `api/f5-…` ·「最后更新跟着读数走：重读同一条读数不换时刻，读不到的那一次没有时刻可给」 | 同一读数重读 → `updatedAt` 不变且上游只被读一次；读失败的一次没有任何可当时刻的值 | 2 |
| （既有的行级覆盖）单行倒计时、拥挤度、失败行、距离、刷新保持 | `web/__tests__/views/platform/departure-minute.test.ts`、`congestion.test.ts`、`failure-row.test.ts`、`landmark-distance.test.ts`、`refresh-retention.test.ts`、`favourites-read-state.test.ts`；`web/__tests__/platform-provenance.test.ts` | 各测行的一个字段/一种状态 | 1 |
| 平台页**自己的**多线路聚合：每行的分钟与站数只来自它自己那条读数 | `web/__tests__/views/platform/aggregation-order.test.ts` ·「分钟与站数都来自本行的读数，绝不跨线借用」「每行问的是自己那条线路在本站台的站序」 | **变异验证**：把各路线的车并进同一个池子逐行复用 → 红（支线那行拿到快线的 10 分钟）；两条线路的读数是同一站序上互相可借的数字 | 1 |
| 平台页**自己的**排序：按到站耗时升序，秒级读数决定谁在前（不是关注顺序 / 线路名 / 站数） | 同上 ·「升序，秒级读数决定谁在前，而不是关注顺序或线路名」「排序按到站耗时，不按站数」「同落到一分钟的两行相邻」 | **变异验证**：比较器取反 → 红；540 s 与 555 s 同落 9 分钟而 600 s 与 120 s 差出一档，站数更多的行因秒数更小仍在前 | 1 |
| 无分钟的行排在所有有数字的行之后 | 同上 ·「无分钟的行排在所有有数字的行之后，且不冒充数字」 | **变异验证**：比较器里 `null` 的两个分支对调 → 红（无分行的行跑到第一行） | 1 |
| 平台页一块屏上每行的来源标记取自自己那条响应 | 同上 ·「实时读数与排班推演在同一块屏上各标自己的那一行」 | 支线声明 `subway_schedule` → 该行「排班推演」而非「实时」；无分钟的行一个标记都不带 | 1 |
| 平台页一块屏上「答了但没车」「读不到」「有车但没有分钟」三种说法互不相同 | `web/__tests__/views/platform/answered-vs-unreadable.test.ts` ·「答了但没车的一行陈述线路自己的运营事实…」「读不到的一行只陈述失败，不冒充运营事实」「三种说法在屏上互不相同，且各自只出现一次」 | **变异验证**：读失败的 `answer: null` 改成空答案 → 红（该行改口说运营事实）；三种说法在整块屏上各只出现一次 | 1 |
| 一行读不到不升级成整块屏的失败 | 同上 ·「只有一行读不到时，失败留在那一行，不升级成整块屏的刷新失败」 | **变异验证**：报告板的 `items.every` 改 `items.some` → 红（单行失败让整块屏说「刷新失败 · 未能取到最新数据」） | 1 |
| 表头与数据行是同一套两列网格（对齐） | `tests/e2e/scenarios/platform.mjs` ·「表头是两列」「数据行左列与表头左列对齐」「数据行与表头相接」 | 落到真实坐标（left/top）断言：只按类名查会让网格换回 12 列那套的回归照样通过 | 3 |
| 每行陈述道路距离（米/公里），与站数并存 | `web/__tests__/views/platform/departure-minute.test.ts` ·「由所请求站的路线距减车的连续位置」「读数没带连续位置时不陈述距离」「规则里本站没有路线距时不陈述距离」 | **变异验证**：把 `distanceToStation` 改成站数*800 的估算 → 红 | 1 |
| 请求失败的行不渲染拥挤度芯片（「无法获取」与「未知」不同行） | `web/__tests__/views/platform/failure-row.test.ts` ·「does not render the chip at all on a failed row」 | 芯片按 `!item.unavailable` 才渲染，同一行不能同时说两件事 | 1 |

**如实说明**：F5 的**第 2 层空白已补**（上表前五行：聚合到同一站台的读侧契约、排序依据、
逐行来源、「没车」与「读不到」、最后更新）；**界面层里「平台页自己的聚合与排序」这一处空白也已补**
（上表后六行：两支 spec 挂载这一页本身，钉住分钟不跨线借用、按到站耗时排序与无分钟的行的位置、
逐行来源、以及「答了但没车 / 读不到 / 有车但没分钟」三种说法各自只出现一次）。仍**未覆盖**的
只剩一处：翻牌动效 / 发光行等视觉形态 —— 界面形态，只能由浏览器 e2e 证明。

## F6 · 线路拓扑报站屏（RouteBoard）

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 响应式站点疏密 / 折返与直线布局算法 | `web/__tests__/route-layout.test.ts` ·「adapts stops per row across screen widths」「computes folded multi-row layout for a 57-station line」「computes single-axis horizontal layout for all stations」 | 布局函数按宽度与站数给出确定结果 | 1 |
| 站序顺序不被重排 | `web/__tests__/views/line-detail/route-board-shaping.test.ts` ·「站序顺序不被重排：板上的站表就是数据源给的序列」 | 站表刻意与站序号不同序（3,1,2）：按序号或按名字重排 → 红 | 1 |
| 车辆就是这次读数里的那几辆、带它们自己的位置 | 同上 ·「每辆车带着自己那次读数里的位置：板不从站表重算」 | 板收到的 `buses` 与响应逐字段相等（含 `distanceFromStart`） | 1 |
| 真实车辆位置在拓扑上的投影 | 同上 ·「站台自己的里程落在该站节点上，两站之间落在它们之间」「折返的第二行沿它自己的方向走：里程增加时位置向左」 | **变异验证**：折返行的同站插值改成永远向右 → 红 | 1 |
| 每站到站分钟的有无 | 同上 ·「每一行陈述自己的到站分钟：有分钟的给数字，没有的陈述缺失」 | 挂真实弹窗：有分钟的一行给出「预计 7 分钟到达」；缺分钟的一行给缺失词且没有 `预计 N 分钟` | 1 |
| 同名两站里恰有一个算上车点（认站靠 (名字, 站序) 这一对） | `web/__tests__/commute-stop-pair.test.ts` ·「报站板的上车点角标比的是一对，不是一个名字」 | 源码钉：角标认站走 `storedStopAt(pt.station, 站名, 站序)`，绝不按名字比（名字比会把两个同名站都标上） | 1 |
| 当前方向的站台角标恰一个；切反向后为 0 | 同上 ·「当前方向的角标恰有一个；切到反方向后一个也没有」 | 屏幕上只有一个目的的方向与本屏相同（两个头部各一处徽标）；切到反方向 → 0 处，且板上没有一个候选 | 1 |
| 线路详情页的其余面（方向、站台态） | `web/__tests__/views/line-detail/direction-one-source.test.ts`、`board-badge-direction.test.ts`、`at-platform-display.test.ts`、`pending-estimate.test.ts`、`provenance.test.ts`、`mobile-purpose-badge.test.ts` | 各自一条断言 | 1 |
| **Konva 图层（轨道/站点节点/列车动态/视口交互）与画布像素** | **无 spec** | —— | **未覆盖** |

**如实说明**：F6 的**数据成形与角标归属**已有行为用例（含一次变异验证），画布之外的部分不再是空白。
仍**未覆盖**的是画布本身：Konva 三个图层、机车图元、缩放/拖拽与视口交互，以及画布上
`board-stop-badge-*` 那个节点画出来的样子。这个仓库没有 canvas 测试台（无 jsdom、无 canvas、
无 `@vue/test-utils`），故像素级证明只能留给浏览器 e2e —— 本批刻意没有写像素断言。

## F7 · 加到主屏

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| manifest 启动参数 / 起始页 / 图标齐全 | `apps/web/src/__tests__/tests/installability.test.ts` ·「launches standalone, with no browser chrome」「starts at the board, not at a sub-page」「declares the 192 and 512 icons…」 | 解析 manifest 逐字段断言 | 1 |
| 点一下直达结论页：`start_url` 就是应用自己的首页 | `apps/web/src/__tests__/tests/install-promise.test.ts` ·「start_url 指的就是应用自己的首页，不是子页也不是一次重定向」 | **变异验证**：把 `start_url` 改成 `/platform` → 红；并断言路由表里 `/` 那一条就是首页（有 `name: 'overview'`、没有 `redirect:`） | 1 |
| 名称 / 短名 / 主题色 / 图标尺寸与 PRD 的承诺一致 | 同上 ·「名称与短名都在，且短名是主屏放得下的那个名字」「display 是 standalone，主题色是一个真实的六位色值」「图标声明齐了安装所需的尺寸与类型」 | 短名 ≤ 12 字；`display` 恰为 `standalone`；主题色与背景色都是六位色值；192 与 512 齐备且有一枚 maskable | 1 |
| 图标文件真实存在且不透明 | `installability.test.ts` ·「gives every declared icon a real file at exactly its declared size」「ships the apple-touch-icon opaque」 | manifest → 解码 PNG 头 | 1 |
| 声明的每个图标都在盘上、尺寸与声明相符 | `install-promise.test.ts` ·「manifest 的条目与 public/ 里的文件一对一」 | 逐条读 IHDR：宽高必须等于声明的 `sizes`，否则报点名的那一条 | 1 |
| **不加 service worker / 不加推送** | `installability.test.ts` ·「ships no worker file and no PWA plugin」「registers no worker from the app source either」；`install-promise.test.ts` ·「没有 worker 文件，也没有注册它的调用点」「没有推送的任何一半」 | 结构缺席（文件、调用点、插件、声明键）；推送另查 `pushManager`/`requestPermission`/`showNotification` 与 manifest 的 push 键 | 1 |
| **真实安装与「点一下直达」的端到端** | **无 spec** | —— | **未覆盖** |

**如实说明**：F7 的安装面在上表逐条钉住（本批补上的是：`start_url` 与首页路由对齐、短名放得下、
图标声明与磁盘文件一对一、以及**推送**的缺席 —— 后者此前没有任何 spec）。`installability.test.ts`
已有的不透明性与可遮罩安全圈断言保持原样，两文件分工是「值」与「承诺」。
仍**未覆盖**的是真实安装的端到端：把站点装到主屏、点图标启动后落在结论页 —— 那要真浏览器。

## F8 · 置顶

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 置顶后排第一，且只有它被标置顶 | `api/f8-pinned-favorite.test.ts` ·「置顶后它排第一，且只有它被标为置顶」 | 列表 id 序 == `[b,a,c]` | 2 |
| 同时只能一条（第二条顶掉第一条） | `api/f8-…` ·「置顶第二条会顶掉第一条：永远只有一条」 | **变异验证**：去掉 setPinned 的「先清后置」→ 红 | 2 |
| 取消置顶落回**自己的**槽（不插头、不坠尾） | `api/f8-…` ·「取消置顶后回到它自己的槽：中间的回到中间」 | `[a,b,c]` 而非 `[b,a,c]`/`[a,c,b]` | 2 |
| 置顶是状态，不改任何 `display_order` | `api/f8-…` ·「置顶不改动任何 display_order」 | 改前改后 `ordersById()` 相等 | 2 |
| 每用户各有各的置顶 | `api/f8-…` ·「每个用户各有各的置顶…」 | 两个用户各 1 行置顶 | 2 |
| 部分唯一索引兜底（绕过应用层也被拒） | `api/f8-…` ·describe「部分唯一索引拒绝第二个置顶」三例 | `23505` | 2 |
| 只在首页存在，设置页不感知 | `web/__tests__/favorite-pin.test.ts` ·「never exposes pin state to the settings screen」 | 设置页无置顶状态 | 1 |
| 标记与入口都在卡片操作栏里，顶边不再有置顶横幅 | `web/__tests__/views/overview/card-action-bar.test.ts` ·describe「置顶横幅不再占卡片顶边」 | 源码不含顶边横幅的 `<div v-if="isPinned" … px-4 py-1.5`；状态由操作栏那格的「已置顶」表示 | 1 |
| 置顶那一格自带按下的状态（`aria-pressed`） | 同上 ·「置顶按下的状态由那一格自己表示」 | 已置顶时名字是「取消置顶」且 `aria-pressed=true` | 1 |
| 置顶那一格的两态字色都由状态类给出，静态类里没有颜色令牌 | `web/__tests__/state-color-override.test.ts` ·describe「颜色令牌：静态与动态不同时给同一个属性」 | 静态类与 `:class` 不得对同一属性都给颜色令牌；**变异验证**：卡片改回「静态写灰 + 动态给青」→ 红 | 1 |
| 全站同一类写法一处都没有（含顶栏汉堡按钮、下拉选项、起降牌读失败行） | 同上 ·「非测试源码里一处这样的写法都没有」 | 该闸门跑出来时顺带修掉了另外 3 处 —— 修前实测四处颜色**全部**失效 | 1 |
| 卡片主体每一块都吃掉余下高度（四种面板不能漏） | `web/__tests__/views/overview/card-action-bar.test.ts` ·「每一种深色面板都吃掉余下高度」 | 四处 `bg-slate-950/80` 面板都带 `grow`；**变异验证**：去掉内容面板的 `grow` → 红 | 1 |
| 四块面板同一圆角（不因有无数据换形状） | 同上 ·「四块面板同一圆角」 | 四处面板的 `rounded-*` 全等且为 `rounded-xl`；**变异验证**：一块改回 `rounded-lg` → 红 | 1 |
| 卡片被拉高时，多出的高度落进深色面板（真布局） | `e2e` ·场景「首页卡片」 ·「卡片被拉高时，多出来的高度落进深色面板里」+「拉高之后没有多出浅色缝」 | 把一张卡抬 90px：面板须长 90px、缝不变；**变异验证**：去掉 `grow` → 面板 168→168、缝 30→120 | 3 |
| 一屏内各卡的深色面板都撑到同一位置 | `e2e` ·同上 ·「各卡的深色面板都撑到操作栏前同一个位置」 | 各卡的「面板底到操作栏」之差 ≤ 1px；**变异验证**：去掉 `grow` → 各卡缝变成 `[30,116,65]` | 3 |
| 卡片主体是通往线路详情的**链接** | `web/__tests__/views/overview/card-action-bar.test.ts` ·describe「卡片主体是通往线路详情的链接」三条 | 主体是 `<a href="/line/…">`、带可访问名、到站分钟区在它里面；**变异验证**：主体改回 `div`+click → 红 | 1 |
| 反方向那一行不带任何字形（⇄ 专指「点它会切换」） | `web/__tests__/views/overview/card-action-bar.test.ts` ·「反方向那一行不带任何字形」 | 那一行子树内 svg 数为 0；**变异验证**：把 ⇄ 放回去 → 红 | 1 |
| 主体里除它自己那枚链接外没有别的可点控件 | 同上 ·「反方向那一行、置顶、切换方向都不在主体里面」 | **变异验证**：反方向那行改回 `button` → 红 | 1 |
| 操作栏每格 ≥44px、等宽 | 同上 ·「每格至少 44px 高」 | 三格都存在且都带 `min-h-11` + `flex-1`；**变异验证**：去掉任一格的 `min-h-11` → 红 | 1 |
| 单向线路不摆「切换方向」那一格 | 同上 ·「单向线路（只有一行）不摆切换方向那一格」 | **变异验证**：去掉 `v-if="canSwitch"` → 红 | 1 |
| 置顶 / 取消置顶都有位移动画，方向由实测位移读出 | `web/__tests__/views/overview/pin-motion.test.ts` ·describe「方向由实测的位移读出，不由动作名读出」 | 位移为正读作「往上走」；**变异验证**：`travelOf` 方向反过来 → 红 | 1 |
| 两向幅度不对称（抬起放大 / 下沉微缩） | 同上 ·describe「抬起与下沉在两端幅度不同」 | 窄屏缩放恒为 1；宽屏 up>1、down<1；**变异验证**：`scaleFor` 两端同值 → 红 | 1 |
| 取消置顶的行程更长，故时长也更长 | 同上 ·describe「取消置顶的行程更长，故时间也更长」 | `durationFor('down') = PIN_DURATION_MS + UNPIN_EXTRA_MS` 且严格大于 `('up')`；**变异验证**：去掉额外那 80ms → 红 | 1 |
| 置顶一律把列表顶带进顶栏下方 | 同上 ·「置顶：它还没到首位 → 把列表顶带进顶栏下方」 | 落点 == `scrollY + gridTop − 顶栏底 − 间隙` | 1 |
| 置顶时「已是首位」不足以判定不必滚 | 同上 ·「它已是首位、但列表顶被滚上去了 → 仍要滚回来」 | 卡片视口 top 为负仍算出正落点；**变异验证**：简化成 `if (isFirst) return null` → 红（单列上真会出现） | 1 |
| 取消置顶只在它看不见时才滚，且只滚到刚够看见 | 同上 ·「它整张都看得见 → 不滚」+「掉到折线以下 → 只滚到刚够看见」 | 可见时落点为 null；不可见时取「露头」与「露尾」里更近的那个 | 1 |
| 动画的坐标在 DOM 更新**之前**量 | 同上 ·describe「接线：动画拿得到「重排前」的坐标」 | 断言 `captureCards()` 的调用夹在 `onBeforeUpdate` 与 `onUpdated` 之间；**变异验证**：把量坐标挪进 `onUpdated` → 红 | 1 |
| 点名只在一次置顶动作期间设下 | 同上 ·「点名只在一次置顶动作期间设下」 | `motionTargetId` 与乐观写入同一 tick 设下、`await nextTick()` 后才撤 | 1 |
| **重排时卡片不瞬移**（只有浏览器做得了） | `e2e` ·场景「首页卡片」 ·「置顶时卡片在旧坐标上被画过一帧」 | 逐帧采样，离起点最近的一帧差 ≤ 24px —— 只看「它到首位了吗」发现不了动画静默失效 | 3 |
| 动画结束后不留下残留的 transform | `e2e` ·同上 ·「动画结束后不留下残留的 transform」 | `getComputedStyle` 的 `transform === 'none'` | 3 |
| 同步滚动的曲线本身单调且前段快于线性 | `web/__tests__/…/pin-motion.test.ts` ·describe「同步滚动的曲线」 | 100 个采样点单调不减、两端严格 0/1、线性曲线求值等于恒等 | 1 |

## F9 · 关注线路拖动排序

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 拖动后顺序即读出顺序（读侧 + 存储都断言） | `api/f9-favorite-display-order.test.ts` ·「拖动后的顺序就是读出来的顺序，存储里也是那一份」 | 读到 `[c,a,b]` 且库里 `display_order` 也是 | 2 |
| 位置并列时按关注先后收敛（`created_at` 决胜） | `api/f9-…` ·「位置相同的两条按关注先后收敛」 | **变异验证**：`createdAt` 决胜取反 → 红 | 2 |
| `0` 是真位置，不是「没给值」 | `api/f9-…` ·「0 是一个真位置，不是「没给值」」 | 写 0 后排序生效 | 2 |
| 置顶只占第一关键字，不改位置 | `api/f9-…` ·「置顶占第一关键字，位置仍管其余的那些」 | `[c,a,b]` → 取消 → `[a,b,c]` | 2 |
| 负数位置被拒（400），行保持原样 | `api/f9-…` ·「负数位置被拒（400），那一行保持原样」 | 400 + 序不变 | 2 |
| 前端整份重写位置、每动一行一条 PATCH | `web/__tests__/favorite-order.test.ts` ·「moves a row down the list and renumbers every position」「sends one displayOrder per row that moved」 | 请求数 == 移动行数 | 1 |
| 设置页显示原始顺序、不含置顶 | `web/__tests__/favorite-order.test.ts` ·describe「the settings order is pin-independent under ties」 | 置顶行留在创建槽 | 1 |

## F10 · 换乘链路与出门决策

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 链路 CRUD：`seq` 由服务端按数组盖章 | `api/f10-commute-chain.test.ts` ·「写入一条链路：两行落下、seq 由数组顺序盖章、客户端给的序号不被采信」 | 忽略客户端 seq，落库为数组序 | 2 |
| `legs` 整段替换、重编号不留空洞 | `api/f10-…` ·「PATCH 的 legs 整段替换，重编号后不留空洞」 | 替换后 seq 连续 0..n-1 | 2 |
| 删链路腿一起走（外键级联） | `api/f10-…` ·「删除链路时它的腿一起走（外键级联）」 | 腿行数为 0 | 2 |
| 起点由 `purpose` 推导，`originAnchor` 被丢 | `api/f10-…` ·「起点由 purpose 推导：payload 里的 originAnchor 一律被丢掉」 | 存下的起点随目的变 | 2 |
| 公交段只能顺行、地铁段可反向、不能同站 | `api/f10-…` ·「公交段只能顺行，地铁段可以反向，同一站不是乘车段」 | 四种组合的接受/拒绝 | 2 |
| 站名与站序成对（半对被拒） | `api/f10-…` ·「站名与站序成对：只给一半的写入被拒，且不留行」 | 400 + 零行 | 2 |
| `transferExtraMinutes`：`null` ≠ `0` | `api/f10-…` ·「接驳方式按段存：null 是没选过，0 是确实没有额外时间」 | 两种值存成不同结果 | 2 |
| 每段时长可溯源、数字来自被点名的那两次读数 | `api/f10-…` ·「一条可推演的链路：余量、带位与每个数字都来自被点名的那两次读数」 | 数字 == 夹具读数（非重算） | 2 |
| 拒绝码各有各的形状 | `api/f10-…` ·anchor-unset / station-unset / no-vehicle / no-shared-vehicle / no-vehicle-after-connection / leg-recorded-backwards / route-unpriced 各一例 | 状态码 + refusal code + 不花多余读数 | 2 |
| 接驳算不出时长：暂时的那一类单独一个码、单独一句话并点名重读，其余三类共用一个码且不承诺重读 | `shared/__tests__/commute-chain.test.ts` ·「keeps every cause the user cannot act on in one code, and the temporary one in its own」+ `web/__tests__/views/commute-chain/chain-refusal.test.ts` ·「names the re-read on the one code whose cause is temporary, and nowhere else」+ `server/__tests__/commute-chain-deduction.test.ts` ·「reports a connection the path service priced no route for as the temporary failure it is」+ `api/f10-…` ·「接驳定不了价时，录反了的那一段也先答自己的接驳码」+ `server/__tests__/station-position-absence.test.ts` | `route-unpriced` 单独成组、其余三个键映射到 `connection-unpriced`、三组并集 == 词汇表键数；只有 `route-unpriced` 的句子含重读词；**变异验证**：把 `route-unpriced` 映射回通用码 → shared 1 条 + server 2 条 + api 1 条红；把句子里的重读词去掉 → web 1 条红 | 1+2 |
| 余量带位与分钟数并存 | `web/__tests__/views/commute-chain/chain-margin.test.ts` ·「bands a leg by the very margin it prints」「prints the number…」 | 带位由它自己打印的分钟推得 | 1 |
| 链路列表可拖动排序 | `web/__tests__/views/settings/commute-chain-order-list.test.ts` ·「列表渲染存储顺序：拖动之后的行序就是拖动后的顺序」 | 拖后行序 == 写入序 | 1 |
| 一级入口、与首页并列 | `web/__tests__/views/commute-chain/chain-page-wiring.test.ts` ·「is in the top-level nav…has a route of its own」 | 导航与路由都注册 | 1 |
| 首页不露出链路结论 | `web/__tests__/views/commute-chain/chain-page-wiring.test.ts` ·「names every leg of a deduced chain…」 | 结论只在链路页 | 1 |
| 录入屏可逐段加到上限（4 段），到上限的按钮禁用并说明边界 | `web/__tests__/views/settings/commute-chain-editor.test.ts` ·「逐段加到上限」 | 段数 == `MAX_CHAIN_LEGS`，按钮 `disabled`；**变异验证**：拆掉 `atLegLimit` 闸门 → 红（这条钉的是机制，不钉那个数 —— 改数由下一条负责） | 1 |
| 上限以上的段数一次写完：段序就是数组顺序 | 同上 ·「上限以上的段数一次写完」 | POST 体里 `legs` 四条，逐段线路/上下车站按数组序；**变异验证**：`chainBodyOf` 里 `slice(0, 2)` → 红；上限改回 2 → 也红 | 1 |
| 推演引擎的段数没有上限：最紧的那次可以落在第三段 | `shared/__tests__/commute-chain.test.ts` ·「reaches a tight boarding past the second leg」 | 三段余量 8/3/2 → `bindingSeq=2`、各段下车分钟逐段累加；**变异验证**：结论只看前两段 → 红 | 1 |
| 六段照样得出结论（段数不是引擎的一维） | 同上 ·「has no leg-count ceiling: six legs deduce like two」 | 六段余量各 3 分、并列取靠前 → `bindingSeq=0` | 1 |
| 读取侧按段渲染：一段一行，段数没有上限 | `web/__tests__/views/commute-chain/chain-leg-rows.test.ts` ·「三段就是三行」「六段也是六行」 | `li` 段行数为 3 / 6，且结论那句点到第 3 段 | 1 |

## F11 · 手动刷新

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 冷却 == 实时缓存 TTL，成功后窗口立刻关 | `api/f11-refresh-throttle.test.ts` ·「冷却就是实时缓存的 TTL，且一次刷新成功后窗口立刻关上」 | 冷却秒数 == TTL | 2 |
| 窗口内拒绝：429 + `Retry-After`，且不读上游 | `api/f11-…` ·「窗口之内（TTL−1）拒绝：429 与 Retry-After 同源，且一次上游都不读」 | 429；上游调用计数 == 0 | 2 |
| 窗口外放行并重读上游 | `api/f11-…` ·「窗口之外（TTL）放行，并重读上游」 | 200；上游调用 == 1 | 2 |
| 两块屏共用一个窗口 | `api/f11-…` ·「两块屏幕共用同一个窗口：命名另一条线路也在这一个冷却之内」 | 第二条线路也 429 | 2 |
| 只刷实时类，不重读长 TTL | `api/f11-…` ·「刷新丢掉两类实时键：按站读数与整线读数都真的重取」「刷新不重读长 TTL 的线路数据」 | 长 TTL 键的取数计数不变 | 2 |
| 上游答不出 → 502，不把作答时刻当读数时刻 | `api/f11-…` ·「上游答不出来时是 502，且绝不把作答时刻当成读数时刻」 | 502 + 时刻字段不动 | 2 |
| UI 三态文案（正在刷新 / 已刷新 / 刷新太频繁） | `web/__tests__/refresh-throttle-ui.test.ts` ·describe「the three states the control has to state」 | 三态三句 | 1 |
| 刷新不清空已在屏上的行；「最后更新」跟随读数 | `web/__tests__/views/platform/refresh-retention.test.ts` ·「(a)…已在屏上的行保持渲染，加载态不出现」「(d)…「最后更新」仍是产生屏上行的那次读取的时刻」 | 刷新中行仍在；时刻不被改写 | 1 |

## F12 · 车厢拥挤度

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 按 `title` **全串精确相等**判定（「不拥挤」绝不被读成拥挤） | `api/f12-congestion-levels.test.ts` ·「每辆车按自己的标签归档：「不拥挤」绝不被读成拥挤」 | **变异验证**：`title.includes('拥挤')` → 红（`不拥挤` 被判 `high`） | 2 |
| 只取实测档位，无「适中」这类中间档 | `api/f12-…` ·「等级只取实测到的那几个，没有中间档」 | 等级落在 `{unknown,low,high}` 内且三种都出现 | 2 |
| 地铁一律 `unknown`（时刻表推不出人多不多） | `api/f12-…` ·「地铁一律 unknown」 | 每辆车 `congestion == 'unknown'` | 2 |
| 界面词取上游实测原词，「未知」自成一档 | `web/__tests__/views/platform/congestion.test.ts` ·「labels each observed level with the wording the upstream itself served」「keeps 「未知」 for every level nobody has sampled」 | 自造词（如「适中」）→ 未知 | 1 |
| 拥挤度不参与自动判断（颜色随判决不随分钟） | `web/__tests__/views/platform/congestion.test.ts` ·「never lets the arrival minute decide a class」 | 类名只由拥挤度决定 | 1 |
| `parseCongestion` 本身 | `packages/transit-adapter/src/__tests__/congestion.test.ts` | 直接单测级别映射 | 1 |

## F13 · 地铁精确时刻表迁入数据库 —— ⚠️ 见下

> **PRD 的 F13 是「存储迁移」阶段，章节标题明确写着「尚未实施」**（`docs/PRD.md` L328）。
> 代码里尚无 `008` 迁移、无从 TS 模块导入数据的加载路径。因此下表覆盖的是**既有的覆写机制**
> （`StationTimetableService`），**不是** F13 的新阶段 —— 不要把它读成 F13 已完成。

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 已转录站答精确、未转录站答推演（同一线路同一刻） | `api/f13-exact-timetable.test.ts` ·「同一线路同一刻：转录的车站答精确，未转录的车站答推演」 | 两站两种 provenance 并存于一次读 | 2 |
| 未转录站按每站 135 秒推演 | `api/f13-…` ·「未转录的车站按每站 135 秒推演：行的分钟落在模型自己的刻度上」 | 分钟落在 135s 刻度 | 2 |
| 注册表作答 | `api/f13-…` ·「已转录的车站由注册表作答」 | 值 == 表内值 | 2 |
| 工作日/双休取表、末班后/首班前返回空、跨零点尾班 | `packages/transit-adapter/src/__tests__/station-timetable.test.ts` · 多例 | 各时刻返回/为空 | 1 |
| 运营状态窗口由表自身班次推出 | `packages/transit-adapter/src/__tests__/exact-timetable-window.test.ts` ·「pins the window to the departures for EVERY shipped table」；`apps/server/src/__tests__/exact-timetable-agreement.test.ts` ·「the board never says service ended while listing departures」 | 表内首末班 == 状态窗口 | 1 |
| **F13 的存储迁移本体（008 迁移、导入、DB 加载路径）** | **无 spec** | —— | **未覆盖（代码未实施）** |

---

## 横切用例（服务多个 F，不属单一编号）

| 关注点 | 证明 | 层级 |
|---|---|---|
| 身份一处解析 query → body → 默认常量 | `api/x-identity-resolution.test.ts` | 2 |
| HTTP 边界 400 / 404 / 409 拿真响应钉住 | `api/x-http-boundary.test.ts` | 2 |
| 迁移顺序连续、幂等、可回滚 | `api/x-migrations-discipline.test.ts` | 2 |
| 库名必须以 `_test` 结尾（硬闸） | `api/test-database-gate.test.ts` | 2 |
| 建库脚本：显式指定的库名就是它建的库，不给名字仍按老规矩派生 | `api/test-db-script.test.ts` | 2 |
| 读不到 ≠ 空（三种结局各有形状） | `api/x-read-state-not-empty.test.ts` | 2 |
| 通勤时段三态（**设置域，不属任何 F**，见改名说明） | `api/commute-window-three-states.test.ts` | 2 |

### 改名说明

原 `api/f5-commute-window-three-states.test.ts` 测的是**通勤时段（`user_settings` 四个时刻）的三态**
（`docs/PRD.md` §4.1 `/settings/schedule` + §5.2），与 **F5（站台聚合大屏）无关**。已改名为中性的
`api/commute-window-three-states.test.ts`：PRD 的 F 清单里没有「通勤时段」这一项（它是一域的设置，
不是功能点），套 `f2-` 也不对（F2 是「通勤起终点锚点 = 家/公司」，不含时刻）。

---

## 未覆盖清单（如实汇总）

1. **F5 站台聚合大屏**：接口层已补（见 F5 节前五行）；平台页自己的多线路聚合、按到站耗时排序、
   逐行来源与「答了但没车 / 读不到 / 有车但没分钟」三种说法也已补（见 F5 节后六行，两支 spec 挂载
   这一页本身）；仍**未覆盖**翻牌/发光等视觉形态 —— 属浏览器 e2e。
2. **F6 线路拓扑报站屏**：数据成形、车辆投影契约与角标归属已补；仍**未覆盖** Konva 图层本身
   （轨道/站点节点/列车动态/视口交互）与画布像素 —— 这个仓库没有 canvas 测试台。
3. **F7 加到主屏**：安装面的字段、图标与「不加 worker、不加推送」已逐条钉住；仍**未覆盖**
   真实安装与「点一下直达」的端到端 —— 属浏览器 e2e。
4. **F13**：存储迁移本体（008 迁移 + 导入 + DB 加载路径）—— **代码未实施，无 spec**。既有覆写机制有覆盖。

## 变异验证（本次实做）

对从未验证过承重的路径各自改坏一次，对应 spec 均变红后从副本复原、`sha256` 核对一致
（1–4 是前一批，5–8 是本批新增的三支 spec 与建库脚本那支）：

| # | 被测 spec | 变异 | 结果 | 被抓的断言 |
|---|---|---|---|---|
| 1 | `api/commute-window-three-states.test.ts` | `db/client.ts` 的 `EMPTY_USER_SETTINGS` 四个时刻填内置值 | 4 failed / 8 passed | 「第二态…四个时刻都是 null」的 `toBeNull()`；「三个状态的读法两两不同」的 `Set.size` |
| 2 | `api/f8-pinned-favorite.test.ts` | `setPinned` 去掉「先清上一个置顶」（SQL 的 `UPDATE … is_pinned = FALSE` 与内存清理循环） | 2 failed / 11 passed | 内存路径 `rows.map(f=>f.id)` ≠ `[b,a]`；SQL 路径第二次置顶 `404 ≠ 200` |
| 3 | `api/f9-favorite-display-order.test.ts` | 内存比较器 `createdAt` 决胜取反 + SQL `ORDER BY created_at DESC` | 4 failed / 6 passed | 「位置相同的两条按关注先后收敛」的 `toEqual([first,second,third])` |
| 4 | `api/f12-congestion-levels.test.ts` | `parseCongestion` → `title.includes('拥挤') ? 'high' : 'low'` | 2 failed / 4 passed | 「不拥挤」被判 `high`（`expected 'high' to be 'low'`） |
| 5 | `api/f5-platform-aggregation.test.ts` | `aggregator.ts` 的 live 缓存键丢掉 `targetOrder`（`${lineId}_${direction}`） | 2 failed / 8 passed | 「分钟是被请求的那一站的价」：两个站序都拿到 180（`expected 180 to be 600`） |
| 6 | `api/test-db-script.test.ts` | `test-db.sh` 不再采信 `TEST_DB_NAME`（退回只按开发库名派生） | 2 failed / 2 passed | 脚本没造出点名的库（`测试库 transit_gap_test …` 而非 `…script_peg_test`）；不合规的库名被接受 |
| 7 | `web/__tests__/views/line-detail/route-board-shaping.test.ts` | `use-route-layout.ts` 折返同站插值 `p2.x - p1.x` → `Math.abs(p2.x - p1.x)`（永远向右） | 1 failed / 6 passed | 「折返的第二行沿它自己的方向走」：`expected 326.25 to be less than 282.5` |
| 8 | `apps/web/src/__tests__/tests/install-promise.test.ts` | `public/manifest.webmanifest` 的 `start_url` 改成 `/platform` | 1 failed / 6 passed | 「start_url 指的就是应用自己的首页」（`expected '/platform' to be '/'`） |
| 9 | `api/f2-anchor-source-and-place-search.test.ts` | `app.ts` 的 `anchorPatchToGcj02` 把来源判断去掉（`search` 也走 `deviceFixToGcj02`） | 4 failed / 28 passed | 「搜索来的坐标原样落库」：落库值 ≠ 高德给的那一对（且等于换算一次的结果） |
| 10 | `api/f2-anchor-source-and-place-search.test.ts` | `anchorPatchToGcj02` 里 `patch[pair.placeName] = null`（名字永不落库） | 2 failed / 30 passed | 「搜索来的坐标原样落库」的 `home_place_name` 逐字断言；「设备路径把上一个搜索来的名字清掉」的反向对照 |
| 11 | `api/f2-anchor-source-and-place-search.test.ts` | `place-search` 的空 keywords 检查短路（`if (false)`） | 2 failed / 30 passed | 「空 keywords → 400」：`expected 200 to be 400` |
| 12 | `api/f2-anchor-source-and-place-search.test.ts` | 地点名/来源的「必须随坐标一起提交」检查短路 | 2 failed / 30 passed | 「单独提交被拒」：`expected 200 to be 400` |
| 13 | `migration-013-anchor-place.test.ts` | 013 的 `home_anchor_source` 加 `NOT NULL DEFAULT 'device'` | 1 failed / 7 passed | 「来源列可空、无默认值」：NOT NULL 与 DEFAULT 各判一次 |
| 14 | `web/__tests__/views/settings/anchor-place-search.test.ts` | `anchor-detail.vue` 加一条 `watch(keyword, …)`（逐字搜索） | 23 failed / 8 passed | 「逐字输入一个请求都不发」：打字之后请求数 ≠ 0 |
| 15 | `web/__tests__/views/settings/anchor-place-search.test.ts` | 保存时来源恒为 `device`（搜索来的也按设备定位提交） | 2 failed / 29 passed | 「坐标 + 名字 + 来源 search」：`homeAnchorSource` 不是 `search` |
| 16 | `web/__tests__/views/settings/anchor-place-search.test.ts` | `anchors.ts` 的 `anchorSummaryOf` 退回「已设置 / 未设置」（丢掉名字与坐标） | 6 failed / 25 passed | 「有名字说名字、没名字说坐标」与「设备抓来的锚点没有名字：摘要显示坐标」 |
| 17 | `web/__tests__/views/settings/settings-index.test.ts` | 路由参数正则去掉（`anchors/:anchor`） | 1 failed / 21 passed | 「参数用正则圈死 home\|work」的结构断言 |

九次变异（9–17）全部被对应 spec 抓住，无需补断言。**被改的五个生产文件，每次改坏前先备份、复原后比对 `sha256`，九次全部一致**（脚本对每个文件都打印 `restore=ok`）。这五个文件复原后的摘要（`sha256sum` 实跑）：

- `apps/server/src/app.ts` → `877be6d6fe26db593aa533db1617e314fdcfb766caf9661cb62afe3ef369fef8`
- `migrations/013_user-settings-anchor-place.sql` → `6bdd0140fa85c73c5e8094837a9f84a0f076518315e6ac13c1c70375e6818174`
- `apps/web/src/views/settings/anchor-detail.vue` → `49f36dfac6dabd83b1316f74b6c628d9c828c8785f5f540745cc83e69898d552`
- `apps/web/src/views/settings/anchors.ts` → `211c10d410f60538af20bc53b9fc4d60d6ae05c484cdd6d098899e2a6c003661`
- `apps/web/src/router/index.ts` → `0dfe19c49ad69f5fa72b70cef68eadf0e812c636e9d159568bc15fbcbc44b58e`

本轮其余生产文件（未被变异，但同属这次改动）的复原后摘要：

- `apps/server/src/db/client.ts` → `1ec9a67eb726974d1b2f63ba29010eff39635643391296e9d8915cc54ad6fe47`
- `apps/server/src/services/transit.service.ts` → `9e7233056e9973916d7dcdd63441ca4c25f3fb2070e99fc6aac77141052f0f41`
- `packages/shared/src/schemas/api.ts` → `151a937d09e5a7270caffaa41442a442ae7a59a37c7ad18afb84f0cd4bd37942`
- `packages/shared/src/schemas/gis.ts` → `653cbc34a00b881d6fb8b08332d050f8e247e44154c3a4c3884e3fc3afd65870`
- `packages/shared/src/geo.ts` → `e83cb7318185aa256a9ea69a077d45c3e59824c4de5df52bd905b8ecf52532a0`
- `packages/transit-adapter/src/services/amap-gis.service.ts` → `67989bbc4c07364305ae67ea2db6e089c46f3ae403f3627daf6b254355d4e3b4`

前一批（1–8）的复原摘要 —— 那是**当时那一版**文件，此后这些文件又被本轮改动过，故
`apps/server/src/db/client.ts` 的摘要与本轮那一份不同（同一路径、不同版本，不是不一致）：

- `apps/server/src/db/client.ts` → `4a92784b52d4ba9bb2c9fde0b31df0fec175cc906c0bfe8b45a2de88ad8a699c`
- `packages/transit-adapter/src/providers/chelaile.ts` → `962aa133ee7aa36c6fcec8fb4c16821e75e61cdd6659ae4504f0285c09380b9f`
- `packages/transit-adapter/src/aggregator.ts` → `ceb4703e912a70b38c367d893bf599ea11c140cf2e97ec798fcb69ce2320285e`
- `scripts/test-db.sh` → `c08f23144c6accbbcbb3a3bc64bf03361fbca2a3f690bf21fbfff2f4c637c7ce`
- `apps/web/src/composables/use-route-layout.ts` → `94d561faec10332bf04ee0c6b9c49a4949b1f7029cb5b2a56410cccd5ebc841a`
- `apps/web/public/manifest.webmanifest` → `0bdf837fe518807ac305e4c0bc1e99f25e3e5546d545594df01aedcdb10bf610`
