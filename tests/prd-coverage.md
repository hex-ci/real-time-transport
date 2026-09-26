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
| 首页卡片读失败不写成「暂无来车」 | `web/views/overview/__tests__/arrivals-read-wording.test.ts` ·「到站读取没答上来：说未读到，不说「前方暂无来车」」 | 文案分支按读取状态选 | 1 |
| 关注列表读失败 ≠ 一条都没关注 | `web/views/overview/__tests__/favourites-read-state.test.ts` ·「读失败时说「未读到关注线路」，不给「还没有关注线路」」 | 两种结局给出不同文案 | 1 |
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
| 早用「家」、晚用「公司」（方向由时段定） | `web/__tests__/reference-line.test.ts` ·「names 公司 for the evening leg」；`web/views/commute-chain/__tests__/chain-purpose-default.test.ts` ·「早上…默认上班」「傍晚…默认下班」 | 早晚两个锚点给出不同答案 | 1 |

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
| （既有的行级覆盖）单行倒计时、拥挤度、失败行、距离、刷新保持 | `web/views/platform/__tests__/departure-minute.test.ts`、`congestion.test.ts`、`failure-row.test.ts`、`landmark-distance.test.ts`、`refresh-retention.test.ts`、`favourites-read-state.test.ts`；`web/__tests__/platform-provenance.test.ts` | 各测行的一个字段/一种状态 | 1 |

**如实说明**：F5 的**第 2 层空白已补**（上表前五行：聚合到同一站台的读侧契约、排序依据、
逐行来源、「没车」与「读不到」、最后更新）。仍**未覆盖**的是两处：

1. 平台页**自己的**聚合与排序代码（`apps/web/src/views/platform/index.vue`：按关注线路并发读 `live`、
   按 `etaMinutes` 升序、无分钟的行排最后、每行的来源取自所属响应）—— 本批钉住的是它消费的接口契约，
   没有任何 spec 驱动这一页本身。
2. 翻牌动效 / 发光行等视觉形态 —— 界面形态，只能由浏览器 e2e 证明。

## F6 · 线路拓扑报站屏（RouteBoard）

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 响应式站点疏密 / 折返与直线布局算法 | `web/__tests__/route-layout.test.ts` ·「adapts stops per row across screen widths」「computes folded multi-row layout for a 57-station line」「computes single-axis horizontal layout for all stations」 | 布局函数按宽度与站数给出确定结果 | 1 |
| 站序顺序不被重排 | `web/views/line-detail/__tests__/route-board-shaping.test.ts` ·「站序顺序不被重排：板上的站表就是数据源给的序列」 | 站表刻意与站序号不同序（3,1,2）：按序号或按名字重排 → 红 | 1 |
| 车辆就是这次读数里的那几辆、带它们自己的位置 | 同上 ·「每辆车带着自己那次读数里的位置：板不从站表重算」 | 板收到的 `buses` 与响应逐字段相等（含 `distanceFromStart`） | 1 |
| 真实车辆位置在拓扑上的投影 | 同上 ·「站台自己的里程落在该站节点上，两站之间落在它们之间」「折返的第二行沿它自己的方向走：里程增加时位置向左」 | **变异验证**：折返行的同站插值改成永远向右 → 红 | 1 |
| 每站到站分钟的有无 | 同上 ·「每一行陈述自己的到站分钟：有分钟的给数字，没有的陈述缺失」 | 挂真实弹窗：有分钟的一行给出「预计 7 分钟到达」；缺分钟的一行给缺失词且没有 `预计 N 分钟` | 1 |
| 同名两站里恰有一个算上车点（认站靠 (名字, 站序) 这一对） | 同上 ·「同名的两站里恰有一个算这个目的的上车点」 | 打开同名而站序不同的那一个：显示「设为上班上车点」而不是「上班上车点 ✓」 | 1 |
| 当前方向的站台角标恰一个；切反向后为 0 | 同上 ·「当前方向的角标恰有一个；切到反方向后一个也没有」 | 屏幕上只有一个目的的方向与本屏相同（两个头部各一处徽标）；切到反方向 → 0 处，且板上没有一个候选 | 1 |
| 线路详情页的其余面（方向、上车点、站台态） | `web/views/line-detail/__tests__/direction-one-source.test.ts`、`board-badge-direction.test.ts`、`board-stop-pair-write.test.ts`、`at-platform-display.test.ts`、`pending-estimate.test.ts`、`provenance.test.ts`、`mobile-purpose-badge.test.ts` | 各自一条断言 | 1 |
| **Konva 图层（轨道/站点节点/列车动态/视口交互）与画布像素** | **无 spec** | —— | **未覆盖** |

**如实说明**：F6 的**数据成形与角标归属**已有行为用例（含一次变异验证），画布之外的部分不再是空白。
仍**未覆盖**的是画布本身：Konva 三个图层、机车图元、缩放/拖拽与视口交互，以及画布上
`board-stop-badge-*` 那个节点画出来的样子。这个仓库没有 canvas 测试台（无 jsdom、无 canvas、
无 `@vue/test-utils`），故像素级证明只能留给浏览器 e2e —— 本批刻意没有写像素断言。

## F7 · 加到主屏

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| manifest 启动参数 / 起始页 / 图标齐全 | `apps/web/tests/installability.test.ts` ·「launches standalone, with no browser chrome」「starts at the board, not at a sub-page」「declares the 192 and 512 icons…」 | 解析 manifest 逐字段断言 | 1 |
| 点一下直达结论页：`start_url` 就是应用自己的首页 | `apps/web/tests/install-promise.test.ts` ·「start_url 指的就是应用自己的首页，不是子页也不是一次重定向」 | **变异验证**：把 `start_url` 改成 `/platform` → 红；并断言路由表里 `/` 那一条就是首页（有 `name: 'overview'`、没有 `redirect:`） | 1 |
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
| 拒绝码各有各的形状 | `api/f10-…` ·anchor-unset / station-unset / no-vehicle / no-shared-vehicle / no-vehicle-after-connection / leg-recorded-backwards / connection-unpriced 各一例 | 状态码 + refusal code + 不花多余读数 | 2 |
| 余量带位与分钟数并存 | `web/views/commute-chain/__tests__/chain-margin.test.ts` ·「bands a leg by the very margin it prints」「prints the number…」 | 带位由它自己打印的分钟推得 | 1 |
| 链路列表可拖动排序 | `web/views/settings/__tests__/commute-chain-order-list.test.ts` ·「列表渲染存储顺序：拖动之后的行序就是拖动后的顺序」 | 拖后行序 == 写入序 | 1 |
| 一级入口、与首页并列 | `web/views/commute-chain/__tests__/chain-page-wiring.test.ts` ·「is in the top-level nav…has a route of its own」 | 导航与路由都注册 | 1 |
| 首页不露出链路结论 | `web/views/commute-chain/__tests__/chain-page-wiring.test.ts` ·「names every leg of a deduced chain…」 | 结论只在链路页 | 1 |

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
| 刷新不清空已在屏上的行；「最后更新」跟随读数 | `web/views/platform/__tests__/refresh-retention.test.ts` ·「(a)…已在屏上的行保持渲染，加载态不出现」「(d)…「最后更新」仍是产生屏上行的那次读取的时刻」 | 刷新中行仍在；时刻不被改写 | 1 |

## F12 · 车厢拥挤度

| 功能点 | 证明（spec · 用例） | 怎么证（区分性断言） | 层级 |
|---|---|---|---|
| 按 `title` **全串精确相等**判定（「不拥挤」绝不被读成拥挤） | `api/f12-congestion-levels.test.ts` ·「每辆车按自己的标签归档：「不拥挤」绝不被读成拥挤」 | **变异验证**：`title.includes('拥挤')` → 红（`不拥挤` 被判 `high`） | 2 |
| 只取实测档位，无「适中」这类中间档 | `api/f12-…` ·「等级只取实测到的那几个，没有中间档」 | 等级落在 `{unknown,low,high}` 内且三种都出现 | 2 |
| 地铁一律 `unknown`（时刻表推不出人多不多） | `api/f12-…` ·「地铁一律 unknown」 | 每辆车 `congestion == 'unknown'` | 2 |
| 界面词取上游实测原词，「未知」自成一档 | `web/views/platform/__tests__/congestion.test.ts` ·「labels each observed level with the wording the upstream itself served」「keeps 「未知」 for every level nobody has sampled」 | 自造词（如「适中」）→ 未知 | 1 |
| 拥挤度不参与自动判断（颜色随判决不随分钟） | `web/views/platform/__tests__/congestion.test.ts` ·「never lets the arrival minute decide a class」 | 类名只由拥挤度决定 | 1 |
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

1. **F5 站台聚合大屏**：其接口层已补（见 F5 节前五行）；仍**未覆盖**平台页自己的多线路聚合与
   按 `etaMinutes` 排序代码，以及翻牌/发光等视觉形态。
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
| 7 | `web/views/line-detail/__tests__/route-board-shaping.test.ts` | `use-route-layout.ts` 折返同站插值 `p2.x - p1.x` → `Math.abs(p2.x - p1.x)`（永远向右） | 1 failed / 6 passed | 「折返的第二行沿它自己的方向走」：`expected 326.25 to be less than 282.5` |
| 8 | `apps/web/tests/install-promise.test.ts` | `public/manifest.webmanifest` 的 `start_url` 改成 `/platform` | 1 failed / 6 passed | 「start_url 指的就是应用自己的首页」（`expected '/platform' to be '/'`） |

八支都被抓住，无需补断言。生产文件复原后的 `sha256`：

- `apps/server/src/db/client.ts` → `4a92784b52d4ba9bb2c9fde0b31df0fec175cc906c0bfe8b45a2de88ad8a699c`
- `packages/transit-adapter/src/providers/chelaile.ts` → `962aa133ee7aa36c6fcec8fb4c16821e75e61cdd6659ae4504f0285c09380b9f`
- `packages/transit-adapter/src/aggregator.ts` → `ceb4703e912a70b38c367d893bf599ea11c140cf2e97ec798fcb69ce2320285e`
- `scripts/test-db.sh` → `c08f23144c6accbbcbb3a3bc64bf03361fbca2a3f690bf21fbfff2f4c637c7ce`
- `apps/web/src/composables/use-route-layout.ts` → `94d561faec10332bf04ee0c6b9c49a4949b1f7029cb5b2a56410cccd5ebc841a`
- `apps/web/public/manifest.webmanifest` → `0bdf837fe518807ac305e4c0bc1e99f25e3e5546d545594df01aedcdb10bf610`
