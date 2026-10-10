# 车来了上游行为参考

> 来源：2026-10-10 对车来了官方客户端的逆向分析。
> - Android 原生 App v7.6.4（APK，梆梆加固，静态分析）
> - 微信小程序 v839（appid `wx71d589ea01ce3321`，wxapkg 解密后反编译，wedecode 还原）
>
> 用途：为本项目后续功能开发提供上游行为基准。**结论可能随官方版本变化，引用时以最新实测为准。**

---

## 1. 刷新架构（核心结论）

| 维度 | 小程序 | 原生 App |
|---|---|---|
| 推送通道 | 无（0 命中 `wx.connectSocket` / `WebSocket` / `wss://`） | 未发现业务 wss/MQTT/Socket.IO（静态分析，未抓包验证） |
| 刷新方式 | 纯 HTTP 轮询 | 纯 HTTP 轮询 |
| 轮询间隔 | **30 秒固定**（`setInterval(..., 3e4)`，写死） | 未知（加固，取不到常量） |
| 页面生命周期 | `onShow` 启动定时器，`onHide`/`onUnload` 停止 | — |
| 手动刷新 | 停自动定时器 → 单次请求 → toast → 2s 后恢复 | — |

**对本项目的意义**：官方同样是"轮询、无长链接"，我们"服务端轮询 + WS 只推给前端"的架构与官方对齐。设置页默认 18 秒比官方 30 秒更激进，保持可调即可，无需向官方看齐。

---

## 2. 接口清单（小程序实测）

| 用途 | 接口 | 说明 |
|---|---|---|
| 首屏全量 | `POST /bus/line!encryptedLineDetail.action` | 线路+站点+车辆全量 |
| 轻量刷新 | `POST /bus/line!encryptedBusDetail.action` | 仅车辆明细，参数 `lineId/targetOrder/stationId/cityId`，对应 30s 定时器 |
| 站点详情 | `POST /bus/stop!encryptedPhyStnDetail.action` | |
| 收藏页批量 | `POST /bus/line!encryptedTsfRealInfos.action` | 参数 `reqSrc=2` |
| 更多车辆 | `POST /bus/line!busList.action` | |
| 时刻表 | `POST /bus/line!preStartTimetableNew.action` | |
| 城市发车间隔 | `GET /bus/cityMaxInterval.action` | ⚠️ 见 §4，不是轮询间隔 |

原生 App 另有一套双接口（包名 `com.ygkj.chelaile.standard`）：
- 首屏全量：`/bus/line!encNLineDetail.action`
- 轻量刷新：`/bus/line!encRefreshLineDetail.action`

本项目当前使用 H5 接口（`encryptedLineDetail`），与小程序同源。

---

## 3. 签名与加解密（已验证，与本项目实现一致）

`packages/transit-adapter/src/providers/chelaile.ts` 中的常量与官方小程序完全一致：

- **签名**：`cryptoSign = md5( JSON.stringify(data) 去掉首尾 `{}` → `:`换`=`、`,`换`&` + `qwihrnbtmj` )`
- **响应解密**：AES-ECB，key（hex）`FF32AE65FBFD19414EAAFF6291A54B42`，解密 `encryptResult` 字段
- **固定参数**：`src=weixinapp_cx`、`s=h5`、`wxs=wx_app`、`sign=1`、`vc=2`、`v=<小程序版本>`

---

## 4. 易误解字段（重要）

| 字段 | 真实含义 | 误解 |
|---|---|---|
| 行详情 `refreshInterval` | **广告位刷新间隔**（小程序代码：`[CllAd AdRefresh]`，钳制 5–180 秒） | ❌ 不是公交数据轮询间隔。H5 渠道实测返回 0 |
| `/bus/cityMaxInterval.action` 返回的 `maxInterval` | **城市发车间隔**（分钟/班），用于展示"预计 X 分钟/班" | ❌ 不是轮询间隔 |

---

## 5. ETA 口径（已验证）

小程序线路详情页直接取服务端 `travels[0].travelTime`，仅做 `prettifySeconds` 格式化（秒→"X分钟"），**客户端不做任何 ETA 计算、不做校准**。

本项目已对齐该原则（`travelTimeSec > 0` 时 `basis: 'upstream'` 直接透传，上游无值时显示"分钟取不到"不编造）。详见 PRD 相关章节。

---

## 6. 小程序包获取与解密（方法沉淀）

Mac 版微信小程序包路径：

```
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users/*/applet/packages/<appid>/<version>/__APP__.wxapkg
```

包是加密的（`V1MMWX` 魔数，包体 AES+XOR），但可用 AppID 解密：

1. `key = PBKDF2-SHA1(appid, salt="saltiest", 1000, 32)`
2. AES-256-CBC 解密魔数后前 1024 字节，IV=`"the iv: 16 bytes"`
3. 取解密结果前 1023 字节 + 剩余部分逐字节 XOR（密钥 = appid 倒数第 2 个字符的 ASCII 值）
4. 解密后头部为 `BE … ED`（14 字节），之后是标准 wxapkg 结构

工具（二选一）：
- 本地脚本：`~/workspace/chelaile-apk/wxapp/decrypt.py` + `unpack2.py`（已验证可用）
- `wedecode`（npm，支持自动解密+完整反编译；对加密包需非交互模式，先用脚本解密再喂给它）

> 注意：iOS / 新版桌面端小程序包同样加密；Android 端历史版本多为明文包。

---

## 7. 原生 App 补充发现（v7.6.4 APK 静态分析）

- 到站提醒走服务端：`/bus/line!updateDebusOrder.action` + 推送（极光 + 小米/华为/OPPO/vivo/荣耀厂商通道），**非常驻轮询**。本项目已决策不做提醒，此处仅记录。
- UI 服务端模块化下发（`modules` / `shieldingModules`）。本项目已决策不做灰度/模块化，仅记录。
- 网络栈 okhttp3 + retrofit2 + Kotlin 协程。
