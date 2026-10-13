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
| 3 浏览器 | `pnpm test:e2e` | 真实浏览器 e2e，六个场景（含电子站牌的选择器键盘场景） |

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
| **操作反馈默认只由提示说一次，屏幕已完整说明结果的动作不推提示**；非操作反馈（读取失败、字段旁的本地校验）才用固定提示条 | `web/__tests__/action-feedback.test.ts` ·「被拒的原因跟在表里那句话后面，除非它只是同一件事换个说法」「每一页的推送点数目恰好是它自己的写操作数：切换与导航一个都不推」+ `web/__tests__/views/overview/action-feedback-overview.test.ts` ·describe「置顶：成功由操作栏自己说」+ `web/__tests__/views/settings/action-feedback-writes.test.ts` ·「被拒：说一句未能保存」「被拒：说一句通勤时段保存失败」+ `web/__tests__/views/settings/anchor-place-search.test.ts` ·「保存失败留在这一页」「写库被拒」「用当前位置失败」+ `web/__tests__/views/settings/commute-chain-editor.test.ts` ·「把 400 的消息原样说一句，表单不关、列表不变」 | 首页置顶/取消置顶成功、失败与回滚均零 toast，由操作栏状态与重排说明；其余写入失败推一句且页上不含重复原因；各页的推送出口数按实际需要固定；`rejectionOf` 只丢「以失败收尾」的缺省句，服务端的成因整句要带上；**变异验证**：把内联加回去 → 对应断言红 | 1+2 |
| 首页卡片读失败不写成「暂无来车」 | `web/__tests__/views/overview/arrivals-read-wording.test.ts` ·「到站读取没答上来：说未读到，不说「前方暂无来车」」 | 文案分支按读取状态选 | 1 |
| 关注列表读失败 ≠ 一条都没关注 | `web/__tests__/views/overview/favourites-read-state.test.ts` ·「读失败时说「未读到关注线路」，不给「还没有关注线路」」 | 两种结局给出不同文案 | 1 |
| 参考行口径 `eta₁−walk ≤ T → 现在走`，否则给出门分钟 | `web/__tests__/reference-line.test.ts` ·「gives a departure time when there is slack to spare」「says leaving now still works, without instructing the user」「says the bus is gone when the walk outlasts it」 | 三种结论互不相同（`reads every verdict differently`） | 1 |
| 无锚点不给参考行（不用默认步行耗时） | `web/__tests__/reference-line.test.ts` ·「the reference line names an unsaved anchor instead of pricing a walk」 | 无锚点时指向设置页，**不**定价 | 1 |
| 参考行是辅助，不隐藏/压缩班次列表 | `web/__tests__/reference-line.test.ts` ·「renders the reference row once…」「places it after the arrivals it refers to」 | DOM 顺序 + 与班次列表互不影响 | 1 |
| **关注站（015 的四列）：按方向各存一对 (站名, 站序)，与时段无关** | `api/f1-followed-station.test.ts` ·「两个方向各存一对，读回同一对；SQL 路径真的落在它自己的列上」「只写一个方向时，另一个方向保持原样」「清空要成对：两列都传 null 才清得掉」「半对被拒：只给站名、或只给站序，都是 400，且原来那一对一动不动」 | 读回值逐字等于写入值；SQL 路径由 `api.rows` **直接读那四列**（不经过服务端映射）；半对 → 400 且原值不动；**这条新用例当场抓到过一个真缺陷**：内存路径的读映射漏了这四列（写路径存了、读回来永远像没设过），已修 | 2 |
| 关注站按方向解析，缺省即跳过回退链 | `shared/__tests__/line-group.test.ts` ·「returns the (name, order) pair for the requested direction」「returns null when that direction has no followed station」「drops a non-integer order to null (identity stays name-only)」 | 两个方向各解出自己那一对；非整数站序退成 `order: null`，不是 -1，也不是编一个 | 1 |
| 附近模式的回退链有半径：超出 3km 就不给「最近站」 | `shared/__tests__/line-group.test.ts` ·「returns null when the nearest stop is beyond NEARBY_RADIUS_M」；`web/__tests__/nearest-station-rule.test.ts` describe「nearness has a radius: beyond it there is NO nearest stop」 | 半径外返回 null（而不是「最近的远站」）；半径内仍给 | 1 |
| 卡片说得出它为什么没有站台，并指向「设关注站」 | `web/__tests__/views/overview/nearby-card.test.ts` ·「says this line has no platform nearby when a position exists」「drops the notice entirely once a platform resolves」 | 有定位且该线附近确实没有站台时才说那一句；站台一解析出来就一个字都不留 | 1 |

## F2 · 通勤起终点锚点

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 成对提交写成一行、读回同一对 | `api/f2-position-anchors.test.ts` ·「成对提交的锚点写成一行，读回来是同一对」 | 读回值等于写入值 | 2 |
| 成对的 `(0,0)` 被拒，且什么都没写 | `api/f2-…` ·「成对的 (0, 0) 被拒，且一个字段都没有写」；`api/x-sentinel-single-parse` ·「(0, 0) 的锚点对被拒在边界上，且一行都没落进存储」 | 400 + 存储零行 | 2 |
| 单轴为 0 是真实坐标，不是哨兵 | `api/f2-…` ·「单轴为 0 是真实坐标，照常写下来」；`api/x-sentinel-single-parse` ·「单轴为 0 是坐标而不是哨兵」 | 写入成功且落库 | 2 |
| 只给一个轴（或只清一个轴）被拒 | `api/f2-…` ·「只给一个轴（或只清一个轴）被拒」 | 400；成对 null 才清空 | 2 |
| WGS-84 只换算一次，站点坐标原样转发 | `api/f2-…` ·「原始 WGS-84 只换算一次」「GIS 边界：设备定位换算一次，站点坐标原样转发」 | 换算调用计数/入参 | 1+2 |
| 锚点这条路：浏览器原样上报，换算在服务端 | `web/__tests__/anchor-capture.test.ts` ·「returns the fix exactly as the browser reported it, converted by nobody」 | 抓来的锚点逐字等于浏览器上报值，且不等于换算一次的结果 | 1 |
| **浏览器本地测距的基准面是 GCJ-02**（定位进入应用时换算一次；上报服务端用原始定位） | `web/__tests__/nearest-station-rule.test.ts` ·「只有定位 store 换算，且只换一次」「反向换算在浏览器里根本不存在」「上报给服务端的定位一律是设备原样的那一份」「picks the placed stop nearest the fix, in metres」；`web/__tests__/location-feedback.test.ts` ·「取到了：说一句已获取位置」（`deviceFix` 原样、`userCoords` 为换算值、两者相差 400 米以上） | 换算调用只出现在 `stores/location.store.ts`；最近站与列表排序的距离从换算后的定位量起 | 1 |
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

## F5 · 电子站牌（站台视角）

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 多线路聚合到同一站台：每行的分钟与车辆只来自它自己那条读数 | `api/f5-live-read-contract.test.ts` ·「同一站台的多条线路各自成行：分钟与车辆只来自它自己那条线的读数」 | 两条线路在同一站序各读一次：对方的 `busId` 不出现在自己的载荷里，两边的分钟各自等于数据源给的那个 | 2 |
| 排序依据：分钟是**被请求的那一站**的价，不是线路末端的价 | `api/f5-…` ·「分钟是被请求的那一站的价：换一个站序读数，同一辆车给出另一行自己的数字」 | **变异验证**：聚合器 live 缓存键丢掉 `targetOrder` → 红（第二次读数重放第一次的 180） | 2 |
| 每行带各自的来源标记 | `api/f5-…` ·「一块屏上各行按各自的来源标记：实时读数与排班推演不是同一个标记」 | 两条线路的 `dataSource` 各不相同且都不缺失（`chelaile` / `subway_schedule`） | 2 |
| 「答了但没车」≠「读不到」 | `api/f5-…` ·「「答了但没车」与「读不到」不互相冒充：一块屏上两种结局的形状不同」 | 200 + 点名线路的空列表（仍带来源与时刻）vs 404 且连 `data` 都没有 | 2 |
| 最后更新跟着读数走 | `api/f5-…` ·「最后更新跟着读数走：重读同一条读数不换时刻，读不到的那一次没有时刻可给」 | 同一读数重读 → `updatedAt` 不变且上游只被读一次；读失败的一次没有任何可当时刻的值 | 2 |
| （新页的行级覆盖）排序、两种东西分开、距本站、数字缺一个不编 | `web/__tests__/views/station-board/board-rows.test.ts` | 各测行的一个字段/一种状态 | 1 |
| 站台列表的顺序：最近的在前，没有距离的不冒充最近 | `web/__tests__/views/station-board/station-options.test.ts` | 坐标由夹具给，断言的是顺序与「不知道就说不知道」 | 1 |
| **列表是一次快照**：几十米的定位抖动不重排、真的走开才重排、下拉正开着时推迟到关上 | `web/__tests__/views/station-board/station-options.test.ts` ·「走开多远才算换了地方：抖动不重排」四条；`station-board-rebuild.test.ts` ·「定位在几十米里打转：顺序不为所动」「真的走开了（400 米）：重排，并重取一次附近的站台」「门槛被设备自己声明的精度抬起来」「下拉开着的时候走开：不重排（也不重取），关上之后才补上」 | 定位换成可控的桩后改坐标；把门槛去掉（改回「每一下都重排」）这三条当场变红 | 1 |
| **记住最后看的那个站台**（刷新/重新进入回到它；不在列表里就退回第一个） | `web/__tests__/views/station-board/remembered-station.test.ts` ·「按城市分开记：换到别的城市再换回来，还是原来那个」「传空串即忘掉这个城市的那一条」「坏值一律当没有」「存储拒写时不抛」；`station-board-page.test.ts` ·「上次看的是列表里的站：重新进入还是它，读的也是它的站牌」「上次看的那一站已经不在列表里：退回第一个，但记忆留着」「按「定位最近站台」= 回到自动并解除固定，而不是把最近的那个固定下来」「固定的那一站**恰好**就是最近的那个：按定位同样解除固定」「没记过时选第一个，且不把自动选中的那个当成「上次看的」」；`tests/e2e/scenarios/station-board.mjs` ·场景「电子站牌」 | 真浏览器里选一个**不是列表第一个**的站，真导航一次，比对它读的站台 id 仍是原来那个 —— 退回列表第一个会读到另一个 id | 1+3 |
| 整屏：答复里每一条线路都渲染（含未关注的）、读不到 ≠ 没有可报的线路、刷新点名站台、重读期间不清空屏 | `web/__tests__/views/station-board/station-board-page.test.ts` | 挂载页面本身；刷新答复由测试挂住，量的是「重读还没有答案」那一刻的屏幕 | 1 |
| 浏览器层：选择器键盘（开面板 / 移动高亮 / 回车拿走高亮项 / Escape 不动值）、换站（名字 + 读数 + 页头一起换）、「距本站」来自载荷、分钟升序、刷新点名站台、**两种来源标记** | `tests/e2e/scenarios/station-board.mjs` ·场景「电子站牌」 | 真按键打到真浏览器；「距本站」的每个数必须落进它收到过的载荷（自造一个、或拿分钟折算，都落不进去）；给上真坐标后下拉里必须出现带「附近」的站，且不是每一行都带（两种来源都在列表里） | 3 |
| **我附近的站台**：坐标 → 站 id（列表的第二个来源，任意未关注站台由此可读） | `server/__tests__/nearby-stops-endpoint.test.ts` ·「答复里每个站都带身份与坐标」「坐标在本边界换算一次」「读不到是 404，附近没有站台是 200 + 空数组」「节拍内重复请求只打一次上游」；`transit-adapter` 的 `nearby-stops-mapping.test.ts` ·「同一个站的不同物理站台合成一条，保留最近的那个」「没有站 id 或没有站名的条目不成行」「坐标缺失就是 null」「上游答了但没有附近站台时是空数组」 | 上游那条端点把同一个站的不同物理站台各给一条，故这一层必须按站 id 去重；坐标换算只做一次、且做在 HTTP 边界 | 2 |
| 两个来源合成一张列表：同名只占一行、标明凭什么在这儿 | `web/__tests__/views/station-board/station-options.test.ts` ·「一个名字一行：两个来源都有的名字算「附近」」「同一个来源里同名只留一条」「关注线路那份没给坐标时用附近那份补上」「合并之后仍然按远近排」；`station-board-page.test.ts` ·「问了附近的站台，并把它与关注线路的站表合成一张列表」「附近站台读不到时退回关注线路的站表」「下拉里的行与触发器上选中的那个用同一套次级文字」 | 桩件把候选渲染成文本，断言的是**下拉里真的标出了什么**；附近读不到时列表退回现状且屏上不出现「附近」（标记只标例外，不标默认） | 1 |

**旧口径那条路径已整体退役（2026-10 复核）**：`/platform` 那页、它的 9 个用例文件、
`platform-provenance.test.ts`、e2e 场景「站台大屏」与两张截图一起下线（`git rm`），导航里只剩「电子站牌」一条。

- 上表**前五行留着**：它们钉的是读侧契约（`GET /lines/:id/live?order=…`），首页卡片与线路页仍按它取价。
- 上表**后十行**钉的是旧屏自己的界面行为，随页面一起消失 —— 其中三件搬到了新页：拥挤度措辞与颜色 →
  `web/__tests__/congestion-copy.test.ts`；「重读期间不清空屏」→ `station-board-page.test.ts`；
  「读不到」与「没有可报的线路」互不冒充 → 同一文件。
- **没有搬过来的**，如实记下 —— 它们不是缺口，是随旧行模型一起消失的状态：逐行来源标记、行级失败芯片、
  「一行读不到不升级成整块屏」、表头对齐的 e2e 坐标断言、旧行模型的距离与站数并存。

**新路径的实现状态**：F5 已按「站台视角」重新定义（见 `docs/PRD.md` F5），实现与用例是：

- 取数层：`GET /api/transit/stations/:stationId/board`（`server/__tests__/station-board-endpoint.test.ts`：
  站上全部线路都在、到站时刻与预报分开、读不到是 404、节拍内重复读只打一次上游、
  按下刷新失效站台缓存并真读一次、节拍内再按一次 429 且不花上游、空按压被拒）
  与适配器的映射函数（`transit-adapter` 的 `station-board-mapping.test.ts`：只取带身份的那一组、
  没有时刻的车不成行、**已经过去的那一班不成行（余量 30 秒）**、-1 距离哨兵不是 0 米、
  拥挤度不混进车辆标签、**线路的静态事实（总站数/本站序/下一站名）不在字段里**）；
- 界面层：电子站牌页 `/station-board` —— `web/__tests__/views/station-board/board-rows.test.ts`
  钉排序（有车的按最快那班在前、只有预报的其次）、两种东西分开、**这趟车距本站多远（缺就不说）**、
  数字缺一个就不编；`station-options.test.ts` 钉站台顺序（最近的在前、没有距离的不冒充最近、
  没有定位时如实说不知道、「最近的也在 3 公里外」这句话何时出现）；`station-board-page.test.ts`
  钉整屏把答复里的每一条线路都渲染出来（含谁都没关注的那条）、「读不到」与「本站没有可报的线路」
  互不冒充、按下刷新时点名的是站台而不是线路、**重读还没有答案时不清空屏也不藏起抬头行**；
- 浏览器层：`tests/e2e/scenarios/station-board.mjs`（场景「电子站牌」）—— 上表倒数第三行。

站台列表按距离排序、手动刷新（与另三页共用冷却窗口）、旧页退役都已落地，见 PRD F5 那几条。
翻牌动效 / 发光行这类视觉形态已从需求中删除（§1.1 明确否掉「给路人看的展示大屏」）。

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
| 点一下直达结论页：`start_url` 就是应用自己的首页 | `apps/web/src/__tests__/tests/install-promise.test.ts` ·「start_url 指的就是应用自己的首页，不是子页也不是一次重定向」 | **变异验证**：把 `start_url` 改成 `/station-board` → 红；并断言路由表里 `/` 那一条就是首页（有 `name: 'overview'`、没有 `redirect:`） | 1 |
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
| 标记与入口都在卡片操作栏里，顶边不再有置顶横幅或 toast | `web/__tests__/views/overview/card-action-bar.test.ts` ·describe「置顶横幅不再占卡片顶边」+ `action-feedback-overview.test.ts` ·describe「置顶：成功由操作栏自己说」 | 源码不含顶边横幅；成功、取消与写入拒绝均不推 toast，状态由操作栏那格与回滚表示 | 1 |
| 置顶那一格自带按下的状态（`aria-pressed`） | 同上 ·「置顶按下的状态由那一格自己表示」 | 已置顶时名字是「取消置顶」且 `aria-pressed=true`；成功与失败都不另推 toast | 1 |
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
| 置顶 / 取消置顶一律由 Vue `<TransitionGroup>` 的 CSS move transition 画 | `web/__tests__/views/overview/transition-group-motion.test.ts` ·describe「Vue TransitionGroup 接线」 | 直接子项是只以关注 id 为 key 的 `div[data-favorite-id]`（不混展示模式）；真浏览器实测：375 下不同 top 28 个、move class 13–539ms，768 下 23 个、22–572ms，结束均无残留 class | 1 |
| 不再保留手动 FLIP / WAAPI / 点名状态 | 同上 ·「不再保留手动 FLIP」 | `card-grid.vue` 不含 `onBeforeUpdate/onUpdated/captureCards/playReorder/motionTargetId`；首页不含 `pinMotionTargetId`；旧 `pin-motion.ts` 与旧测试均已删除 | 1 |
| move 只过渡 transform，且尊重减少动画 | 同上 ·「move 样式只过渡 transform」 | `favorite-reorder-move` 是 400ms transform transition；`prefers-reduced-motion` 下为 none | 1 |
| 列表更新不换未改变项的对象身份 | `web/__tests__/favorite-pin.test.ts` ·「不把没变过的关注行换成新对象」 | 置顶 `fa` 后 `fb`/`fc` 仍为原对象（`toBe`）；**变异验证**：去掉 `&& f.isPinned` → 红 | 1 |
| 置顶与取消置顶都不动视口；move 的 400ms 内锁住下一次操作 | `web/__tests__/views/overview/action-feedback-overview.test.ts` ·「置顶与取消置顶都不动视口：卡片走到新槽位就是全部」「写入结束后 CSS move 的 400ms 内仍锁住操作」 | 置顶与取消置顶各走完一次 move 都不调用 `scrollTo`；立刻再按不产生第二个写入 | 1 |
| **重排时卡片不瞬移**（只有浏览器做得了） | `e2e` ·场景「首页卡片」 ·「置顶时 Vue move transition 给出中间位置」 | 逐帧采样至少 4 个不同 top；顺序正确且结束无残留 transform | 3 |

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
| 刷新不清空已在屏上的行；「最后更新」跟随读数 | `web/__tests__/views/station-board/station-board-page.test.ts` ·「重读还没有答案时不清空屏：行与「最后更新」都在，且时刻仍是产生这些行的那一次读取」 | 刷新答复由测试挂住：请求还挂着时，行与抬头行都必须还在 | 1 |
| **实时节拍可调：10~120 秒，越界钳两端，非法回退 18** | `server/__tests__/refresh-interval.test.ts` ·「区间内的整数原样保留」「越界被钳到两端，小数四舍五入」「环境变量给的是字符串也算数」「读不出数就回退默认，绝不写成 NaN 或 0」 | 钳制后的值逐个相等；回退值是 18 而不是 0 或 NaN | 1 |
| **手动刷新的冷却跟随当前节拍，且热切换不重启服务** | 同上 ·「按 30 秒配置：窗口开在尝试那一刻，29 999ms 拒、30 000ms 放行」「换成 10 秒：同一个进程里立刻按新的节拍算窗口」「保存一个非法值时回退默认 18，而不是让节拍变成 0 秒」 | 窗口长度 == 节拍（由响应自己的 `nextAllowedAt` 与 `retryAfterSeconds` 读）；`setPollIntervalSec` 之后另一个窗口立刻按新节拍开；**已开的窗口保留自己的到期时刻**（调快不改写别人手里那个） | 1 |
| 设置索引那一行的四种事实（没选过 / 选过 / 读不到 / 连生效值都没读到） | `web/__tests__/views/settings/settings-index.test.ts` ·「实时刷新间隔行说此刻生效的秒数或所选秒数，读不到就说读不到」 | 「未设置（默认每 18 秒）」/「未设置（默认每 30 秒）」（运维改过环境变量的服务端）/「每 N 秒」/「未读到」/「未设置」五句互不相同；读不到时不许出现「18 秒」；答案里没有生效值时只说「未设置」，不拿 18 顶上 | 1 |
| 刷新间隔子页的「当前」与编辑器起点 | `web/__tests__/views/settings/refresh-interval-page.test.ts` ·「生效 30 秒 → 起点是 30 而不是 18」「生效 18 秒」「读完但没有生效值」「选了 10 秒」「读取失败」「按 60 秒再保存」 | 那句话与起点都取**此刻在跑的**数（30/18 各一句）、读不到时说「未读到设置」且不印「只是起点」那句、保存写回的请求体是选中那一档且写完那句话跟着改 | 2 |
| 站点选择器的键盘（打开 / 移动高亮 / 回车选中 + 重读 / Escape 关且不动值） | `e2e` ·场景「电子站牌」（`tests/e2e/scenarios/station-board.mjs`）·「关着时上/下键不开面板：开面板是原生激活那条路」「Enter 打开面板并列出候选」「下键建立高亮，且恰有一项（reka 的 data-highlighted）」「再按一次把高亮移到另一项」「回车拿走的是高亮那一项」「Escape 关掉面板且不动值」 | 真按键打到真浏览器：高亮读 reka 的 `data-highlighted`、回车后 `trigger` 换成高亮那一站且 `/live` 重读过；**背景**：组件换成 reka 的 Combobox 后，宿主（不冒泡、不跑默认动作）量不到这些，单元层只剩「本组件不抢键」那半 | 3 |
| **节拍听谁的：设置页的选择（DB）> 环境变量 > 启动参数 > 默认 18s** | `server/__tests__/refresh-interval.test.ts` ·「三处都给了：用设置页那个」「设置页没选过（NULL）：落到环境变量」「设置页与环境变量都没有：用启动参数」「三处都没有：undefined，交给构造时落默认 18」「环境变量读不出数就当它没给，不吃掉后面的来源」「这条链不钳制取值」 | 六种来源组合各给出确定的答案；`abc` 这类读不出数的环境变量被当作「没给」而不是「给过」；**接线**另有三条源码断言：`buildApp` 把来源喂给那条链、`index.ts` 不再自己解析环境变量、`app.ts` 里那个环境变量也只读一次（曾经两处各写一份、对无效值的判法还不一样） | 1 |
| **接口答出的「生效节拍」就是此刻在跑的** | `server/__tests__/refresh-interval.test.ts` ·「没选过 + 环境变量 30 → 答 30，而不是存储行说的 18」「选过 10 → 答 10：环境变量的 30 盖不掉使用者的选择」「清空选择（PATCH null）→ 回到环境变量的 30，与重启后同一个答案」「两个来源都没有 → 18」 | 真 app + `inject`：读的答复（与写回的答复）里的 `effectiveRefreshIntervalSec` 逐个相等；清空之后那一列回到 NULL 而行还在，且节拍落到**与环境变量一致**的 30 —— 同一份存储状态不因「有没有重启过」得到两个节拍 | 2 |

**如实说明**：这条优先级的**规则**有纯函数（`resolvePollIntervalSec`）与它的用例，**接线**由三条源码断言钉住，
「此刻在跑几秒」由接口答出并有真 app 的用例（含清空后与重启同一个答案）；
仍没有测试的是服务自身的定时器真的按那个数触发一次 —— 那要观测真实推送节奏，属浏览器层，未做。

## F12 · 车厢拥挤度

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 按 `title` **全串精确相等**判定（「不拥挤」绝不被读成拥挤） | `api/f12-congestion-levels.test.ts` ·「每辆车按自己的标签归档：「不拥挤」绝不被读成拥挤」 | **变异验证**：`title.includes('拥挤')` → 红（`不拥挤` 被判 `high`） | 2 |
| 只取实测档位，无「适中」这类中间档 | `api/f12-…` ·「等级只取实测到的那几个，没有中间档」 | 等级落在 `{unknown,low,high}` 内且三种都出现 | 2 |
| 地铁一律 `unknown`（时刻表推不出人多不多） | `api/f12-…` ·「地铁一律 unknown」 | 每辆车 `congestion == 'unknown'` | 2 |
| 界面词取数据源实测原词，「未知」自成一档 | `web/__tests__/congestion-copy.test.ts` ·「labels each observed level with the wording the upstream itself served」「keeps 「未知」 for every level nobody has sampled」 | 自造词（如「适中」）→ 未知 | 1 |
| 拥挤度不参与自动判断（颜色随判决不随分钟） | `web/__tests__/congestion-copy.test.ts` ·「never lets the arrival minute decide a class」 | 类名只由拥挤度决定 | 1 |
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
（`docs/PRD.md` §4.1 `/settings/schedule` + §5.2），与 **F5（电子站牌）无关**。已改名为中性的
`api/commute-window-three-states.test.ts`：PRD 的 F 清单里没有「通勤时段」这一项（它是一域的设置，
不是功能点），套 `f2-` 也不对（F2 是「通勤起终点锚点 = 家/公司」，不含时刻）。

---

## 未覆盖清单（如实汇总）

1. **F5 电子站牌**：**已无未覆盖项** —— 旧口径那条路径（`/platform`）连同它的用例整体退役，
   F5 现在只有一条路径（`/station-board`），取数层、适配器映射、行规则、站台顺序、整屏与浏览器层
   都有用例，见 F5 节末那段「实现状态」。
2. **F6 线路拓扑报站屏**：数据成形、车辆投影契约与角标归属已补；仍**未覆盖** Konva 图层本身
   （轨道/站点节点/列车动态/视口交互）与画布像素 —— 这个仓库没有 canvas 测试台。
3. **F7 加到主屏**：安装面的字段、图标与「不加 worker、不加推送」已逐条钉住；仍**未覆盖**
   真实安装与「点一下直达」的端到端 —— 属浏览器 e2e。
4. **F13**：存储迁移本体（008 迁移 + 导入 + DB 加载路径）—— **代码未实施，无 spec**。既有覆写机制有覆盖。
5. **「此刻在跑的节拍」与「轮询真的按它跑」之间那一步**：接口答出的生效值有 spec（F11 第 5 行），
   来源规则与清空的回落也都有；仍**未覆盖**服务自身的定时器真的按 N 秒触发一次 ——
   观测它要靠真实推送节奏，属浏览器层，未做。
6. **关注站的写入界面**：`web/__tests__/views/overview/` 下有卡片空态与回退链的用例，但
   `views/overview/components/followed-station-sheet.vue`（保存与清除的差异合并）与
   `stores/transit.store.ts` 的 `setFollowedStation` 仍**无 spec** —— 面板把哪几个方向送回去、
   清除时送什么，目前只有实现本身说了算（落库那半已在 F1 的 `api/f1-followed-station.test.ts` 钉住）。
7. **环线分组**（`line-group.ts` 的 `normalizeGroupName` / `isLoopPair`）：`groupLineSummaries` 的用例
   全是普通线路名，**没有 300内 / 300外 这一对**；「环线必须双向确认、单个 X 内不得误伤」这条
   判据目前没有用例。混搭后缀的限制已写进 `isLoopPair` 的注释（实测数据里都是同风格成对）。
8. **城市码的新增与归一**：`cities.ts` 的新城市（006 / 040 / 014 / 036 / 017）与 `normalizeCityCode`
   的别名归一，唯一断言它的 `multi-city-smoke.live.test.ts` 是 `describe.skip`（默认恒跳过）。
9. **`use-commute-purpose` 的 hook 形态**（60 秒 tick 与卸载清理）：纯函数 `purposeForMinutes` 有 spec，
   但 `useCommutePurpose` 的读取与定时器**无 spec**。
10. **「在本站」的 20 米阈值**：`at-platform-arrival.test.ts` 用的是 60 米（35 / 20 两档都落在它之外，
    而阈值本身已从 35 改成 20 米，注释同步过了），即阈值那一侧没有用例。
11. **`db/client.ts` 的「DATABASE_URL 配了但连不上 → 直接报错、不回退内存」**：`db-connection-guard.test.ts`
    的 pg 桩 `connect` 恒成功，走不到那个 `catch`。

## 变异验证（本次实做）

> **下面的摘要是「当时那一版」文件的**：此后这些文件又被后续改动过，故它们**不再等于现在盘上的文件**
> （2026-10 复核：`app.ts`、`router/index.ts`、`services/transit.service.ts`、`db/client.ts`、
> `schemas/api.ts`、`geo.ts`、`views/settings/anchor-detail.vue` 七个已与表里不同；`013` 迁移、
> `anchors.ts`、`schemas/gis.ts`、`amap-gis.service.ts` 四个仍未变）。
> 表本身记录的是「那一次改坏确实被抓到了」，不是「当前文件的指纹」—— 要恢复这个用途就得重跑一遍。

对从未验证过承重的路径各自改坏一次，对应 spec 均变红后从副本复原、`sha256` 核对一致
（1–4 是前一批，5–8 是本批新增的三支 spec 与建库脚本那支）：

| # | 被测 spec | 变异 | 结果 | 被抓的断言 |
|---|---|---|---|---|
| 1 | `api/commute-window-three-states.test.ts` | `db/client.ts` 的 `EMPTY_USER_SETTINGS` 四个时刻填内置值 | 4 failed / 8 passed | 「第二态…四个时刻都是 null」的 `toBeNull()`；「三个状态的读法两两不同」的 `Set.size` |
| 2 | `api/f8-pinned-favorite.test.ts` | `setPinned` 去掉「先清上一个置顶」（SQL 的 `UPDATE … is_pinned = FALSE` 与内存清理循环） | 2 failed / 11 passed | 内存路径 `rows.map(f=>f.id)` ≠ `[b,a]`；SQL 路径第二次置顶 `404 ≠ 200` |
| 3 | `api/f9-favorite-display-order.test.ts` | 内存比较器 `createdAt` 决胜取反 + SQL `ORDER BY created_at DESC` | 4 failed / 6 passed | 「位置相同的两条按关注先后收敛」的 `toEqual([first,second,third])` |
| 4 | `api/f12-congestion-levels.test.ts` | `parseCongestion` → `title.includes('拥挤') ? 'high' : 'low'` | 2 failed / 4 passed | 「不拥挤」被判 `high`（`expected 'high' to be 'low'`） |
| 5 | `api/f5-live-read-contract.test.ts` | `aggregator.ts` 的 live 缓存键丢掉 `targetOrder`（`${lineId}_${direction}`） | 2 failed / 8 passed | 「分钟是被请求的那一站的价」：两个站序都拿到 180（`expected 180 to be 600`） |
| 6 | `api/test-db-script.test.ts` | `test-db.sh` 不再采信 `TEST_DB_NAME`（退回只按开发库名派生） | 2 failed / 2 passed | 脚本没造出点名的库（`测试库 transit_gap_test …` 而非 `…script_peg_test`）；不合规的库名被接受 |
| 7 | `web/__tests__/views/line-detail/route-board-shaping.test.ts` | `use-route-layout.ts` 折返同站插值 `p2.x - p1.x` → `Math.abs(p2.x - p1.x)`（永远向右） | 1 failed / 6 passed | 「折返的第二行沿它自己的方向走」：`expected 326.25 to be less than 282.5` |
| 8 | `apps/web/src/__tests__/tests/install-promise.test.ts` | `public/manifest.webmanifest` 的 `start_url` 改成 `/station-board` | 1 failed / 6 passed | 「start_url 指的就是应用自己的首页」（`expected '/station-board' to be '/'`） |
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
