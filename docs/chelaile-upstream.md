# 车来了上游行为参考

> 来源：对车来了官方客户端的行为观察与接口实测。
>
> 用途：为本项目后续功能开发提供上游协议与行为基准。**结论可能随官方版本变化，引用时以最新实测为准。**

---

## 1. 刷新架构（核心结论）

| 维度 | 小程序 | 原生 App |
|---|---|---|
| 推送通道 | 无（0 命中 `wx.connectSocket` / `WebSocket` / `wss://`） | 未发现业务 wss/MQTT/Socket.IO（静态分析，未抓包验证） |
| 刷新方式 | 纯 HTTP 轮询 | 纯 HTTP 轮询 |
| 轮询间隔 | **30 秒固定**（`setInterval(..., 3e4)`，写死） | 未知 |
| 页面生命周期 | `onShow` 启动定时器，`onHide`/`onUnload` 停止 | — |
| 手动刷新 | 停自动定时器 → 单次请求 → toast → 2s 后恢复 | — |

**对本项目的意义**：官方同样是"轮询、无长链接"，我们"服务端轮询 + WS 只推给前端"的架构与官方对齐。设置页默认 18 秒比官方 30 秒更激进，保持可调即可，无需向官方看齐。

---

## 2. 接口清单（小程序实测）

| 用途 | 接口 | 说明 |
|---|---|---|
| 首屏全量 | `POST /bus/line!encryptedLineDetail.action` | 线路+站点+车辆全量 |
| 轻量刷新 | `POST /bus/line!encryptedBusDetail.action` | 仅车辆明细，参数 `lineId/targetOrder/stationId/cityId`，对应 30s 定时器 |
| 站点详情 | `POST /bus/stop!encryptedPhyStnDetail.action` | 参数 `stationId` + `cityId`（只给 `stationId` 答空对象，`stopId` 这个名字不认）+ **`lineId`（非空即可，见下）**。返回 `stationList[]`，**第一组**就是所查的那个站：该站全部经过线路（未关注的也在内）各车的 `arrivalTime`（epoch 毫秒）+ `stnStates[].distanceToDest`（**这辆车距本站还有多少米**，见下方误解行）+ 线路元数据（`lineId` / 方向 / 开往 / 首末班 / 票价 / 站数 / 本站序 / 下一站）。另：`stnStates[].travelTime` 与该车的剩余秒数同值（上游自己的行程时间），`busTagList` 是车辆标签（拥挤度那几个词也在这里，故两者要分开取） |
| 站点详情 · **`lineId` 是「全站视图」的开关** | 同一个站名两侧的站牌（物理站牌 `physicalStId`）在 `stationList[]` 里各占一组，但**只有带 `lineId` 的那次调用会把各组都补上线路身份**：不带 → 只有本侧平台那几条线（**一条线路只剩一个方向**）；带（**任何非空值都行**，实测给一条不经过本站的 id、甚至 `x` 都一样；空串或空格退回前者）→ 各组并成一组，两侧站牌的线路全在，**同一条线的两个方向各占一条**（`lineId` 也各不同）。2026-10-13 实测（万盛南街西口 `010-20607`）：不带 5 条线路（T12 只有 dir0）、带上 13 条（T12 的 dir0 与 dir1 都在，各自带自己的到站车数）。故本仓固定带上 `WHOLE_STATION_VIEW_LINE_ID`（值不参与取数） |
| **附近站台** | `POST /bus/stop!encryptedNearPhysicalStns.action` | 参数 `cityId` + `lng`/`lat`（GCJ-02）—— **不给 `cityId` 答空列表**。返回 `nearStations[]`：`sId`（站 id）/ `sn`（站名）/ `distance`（米，升序）/ `lat`/`lng`/`physicalStId`/`namesakeStId`/`sType`。**没有半径参数**（`radius`、`distance` 传什么都不变），窗口由上游定：实测约 1 公里、15～48 条；**同一个站的不同物理站台会各占一条**，按 `sId` 去重后是 6～21 个站。这是「任意未关注站台」那条路的桥：坐标 → 站 id（2026-10-13 实测） |
| 首屏 | `POST /bus/stop!encryptedHomePage.action` | 返回 `{toast, nearSts, tag, lines}`；只给 `cityId` + 坐标时两者都为空 —— **参数未确认**（附近站台请走上一行） |
| 搜索 | `POST /bus/query!encryptedNSearch.action`、`!encryptedSearchMore.action` | 按关键词搜站/线；`keyword` 不是它的参数名（答空对象），**参数未确认** |
| 收藏页批量 | `POST /bus/line!encryptedTsfRealInfos.action` | 参数 `reqSrc=2` |
| 更多车辆 | `POST /bus/line!busList.action` | |
| 时刻表 | `POST /bus/line!preStartTimetableNew.action` | |
| 城市发车间隔 | `GET /bus/cityMaxInterval.action` | ⚠️ 见 §4，不是轮询间隔 |

原生 App 另有一套双接口（包名 `com.ygkj.chelaile.standard`）：
- 首屏全量：`/bus/line!encNLineDetail.action`
- 轻量刷新：`/bus/line!encRefreshLineDetail.action`

本项目当前使用 H5 接口（`encryptedLineDetail`），与小程序同源。电子站牌页（PRD F5）另用**站点详情**（`encryptedPhyStnDetail`）—— 它一次就给出该站全部经过线路的到站时刻（带上 `lineId` 时含两侧站牌、同一条线的两个方向各一条）；「我附近的站台有哪些」走**附近站台**（`encryptedNearPhysicalStns`）。

### 2.1 端点总清单

共 **73 条** `.action`，与公交读取相关的是：

```
/bus/stop!encryptedHomePage.action            /bus/stop!encryptedNearPhysicalStns.action
/bus/stop!encryptedPhyStnDetail.action        /bus/stop!encryptedRecommLine.action
/bus/line!encryptedLineDetail.action          /bus/line!encryptedBusDetail.action
/bus/line!encNLineDetail.action               /bus/line!encRefreshLineDetail.action
/bus/line!encryptedTsfRealInfos.action        /bus/line!busList.action
/bus/line!lineRoute.action                    /bus/line!summary.action
/bus/line!difStnTips.action                   /bus/line!noTips.action
/bus/line!queryFavByLineNos.action            /bus/line!subject.action
/bus/query!encryptedNSearch.action            /bus/query!encryptedSearchMore.action
/bus/query!encrypteFavDetail.action           /bus/query!voiceSearchGuide.action
/bus/busLabel!getStopInfos.action             /bus/fav!*  /bus/poi!*  /bus/reminder!*
/transfer/transit!encryptedIntegrate.action   /transfer/transit!tripPlan.action
```

其余是账号（`/wow/user!*`）、广告（`/adpub/*`）、更新与埋点，与本项目无关。**除本文件已记录参数的那几条，其余参数一律未验证** —— 名字像什么不算证据。

---

## 3. 签名与加解密

`packages/transit-adapter/src/providers/chelaile.ts` 中的常量与官方小程序完全一致：

- **签名**：`cryptoSign = md5( JSON.stringify(data) 去掉首尾 `{}` → `:`换`=`、`,`换`&` + `qwihrnbtmj` )`
- **响应解密**：AES-ECB，key（hex）`FF32AE65FBFD19414EAAFF6291A54B42`，解密 `encryptResult` 字段
- **固定参数**：`src=weixinapp_cx`、`s=h5`、`wxs=wx_app`、`sign=1`、`vc=2`、`v=<小程序版本>`

---

## 4. 易误解字段

| 字段 | 真实含义 | 误解 |
|---|---|---|
| 站点详情 `stnStates[].distanceToDest` | 上游按**被查的那个目标**作答：查站台时它就是**这辆车距本站还有多少米**（实测同一份读数里 791s/3175m、484s/2408m、333s/1716m —— 距离 ÷ 时间 ≈ 4～5 m/s，即车速） | ❌ 按字段名读成「距终点」—— 查站台时它不是距终点；本项目曾这样读错过一次，屏上多了一栏没有信息量的「距终点还有几站」 |
| 站点详情 `stnStates[]` 里**已经过去的那一班** | 上游留着上一班（`arrivalTime` 在过去、`travelTime` 为 -1、`distanceToDest` 是几公里外的旧读数） | ❌ 当成在途车 —— 它的剩余秒数是负的，按分钟规则会落在 0 上被读成「正进站」，即屏上多一辆不在那儿的车。本项目在适配器层按读数时刻剔除（留 30 秒余量给上下游钟差） |
| 站点详情 `stationList[1..]` | 同一个站的**其余物理站台**：`sId` 与 `namesakeStId` 与所查站完全相同，`physicalStId` 与坐标各不相同（实测四组：39.8617/116.6236、39.8613/116.6238、39.8631/116.6256、39.8634/116.6258），每组带一部分线路（首组带完整身份与在途车，其余组只有线路元数据、`lineId` 为空） | ❌ 当作「附近站台」用 —— 它们是**同一个站**的不同站台，不是空间上的邻近站；也❌ 拿它当「附近站有哪些」的来源：它只覆盖这一个站 |
| 站点详情 `lines[].preArrivalTime` | 该线此刻**没有在途车**时的**发车间隔预报**窗口（如 `15:53~16:03`） | ❌ 与在途车的到站时刻（`stnStates[].arrivalTime`）混为一谈 —— 一个是车什么时候到，一个是多久一班 |
| 站点详情 `arrivingStationLimitSeconds` / `arrivingStationTimeDisplayConfig` / `menuStyle` / `busDisplayConfig` / `operationPosition` / `transferDisLimit` / `locationType` | **语义未确认** | ❌ 按名字猜用途 —— 名字像什么不算证据 |
| 行详情 `refreshInterval` | **广告位刷新间隔**（小程序代码：`[CllAd AdRefresh]`，钳制 5–180 秒） | ❌ 不是公交数据轮询间隔。H5 渠道实测返回 0 |
| `/bus/cityMaxInterval.action` 返回的 `maxInterval` | **城市发车间隔**（分钟/班），用于展示"预计 X 分钟/班" | ❌ 不是轮询间隔 |

---

## 5. ETA 口径

小程序线路详情页直接取服务端 `travels[0].travelTime`，仅做 `prettifySeconds` 格式化（秒→"X分钟"），**客户端不做任何 ETA 计算、不做校准**。

本项目已对齐该原则（`travelTimeSec > 0` 时 `basis: 'upstream'` 直接透传，上游无值时显示"分钟取不到"不编造）。详见 PRD 相关章节。
