# 实时交通 PRD

## 1. 产品概述与定位

### 1.1 产品愿景
打造一套轻量、纯粹、高信息密度的移动端优先实时公交与地铁可视化系统。抛弃传统地图类 App 臃肿的商业化元素与重型底图渲染，专注于以**纯粹的拓扑线路图与车厢式动态站牌**呈现车辆实时动态，帮助通勤者在 1 秒内获知核心决策信息：“车在哪里、还有多久到、要不要跑向车站”。

### 1.2 核心设计原则
1. **纯粹拓扑，拒绝冗余地理底图**：不加载复杂瓦片地图与弯曲路网，完全依托拓扑站点逻辑轴线展现相对空间关系，极大降低渲染负担与视觉干扰。
2. **折返与直线（Route Board）站牌美学**：针对国内（尤其北京）动辄 40~60 个站点的超长公交线路（如 913、T12 等），采用类似经典公交站牌的多行“折返走线”机制，解决窄屏排布痛点，并支持随时一键切换为直线贯通单轴长卷。
3. **极客工业风（Dark-mode First）**：
   - 界面主基调为深空暗色（`#0B0F19` / `#0F172A`），契合 OLED 节能与高对比度需求。
   - 轨道与站点采用通透呼吸发光光效（Glow Effect），数字统一采用等宽字体（JetBrains Mono / DIN）。
   - 动效即信息：仅在车辆位移推算、到站脉冲、拥挤度状态变化时触发平滑过渡，严禁无关装饰动效。

---

## 2. 页面架构与视图交互设计

系统包含四大视图与一个管理配置模块：

```
[首页 /] 关注线路卡片流 + 顶部通勤情境条 + 站台聚合模式快捷入口
   │
   ├── [线路详情 /line/:id]
   │      └── 核心视图：Konva.js 折返与直线动态报站屏（RouteBoard）
   │
   ├── [站台大屏 /platform/:stationId] 虚拟站台多线起降看板
   │
   ├── [玄关模式 /kiosk] 横屏贯通式多线监控看板（Web Wake Lock 常亮）
   │
   └── [管理配置 /settings] 关注线路增删、通勤起止站配置、数据源健康度监控
```

### 2.1 首页：动态关注流（Overview）
- **顶部 Smart Context 条**：
  - 结合当前时间与设备定位，自适应显示通勤情境（如“早高峰·去公司”、“晚高峰·回家”），支持一键反向。
- **线路微缩动态卡片**：
  - 卡片顶部：线路编号、终点站、上下行切换开关。
  - **微缩轨道（Mini Sparkline）**：纯矢量折线轨道，显示站点小圆点、金色离我最近站标识，以及在途车辆的实时位置脉冲。
  - **核心到站看板**：
    - 大字号高亮：“下一班 **3** 分钟（距当前站 2 站 · 1.1 km）”。
    - 状态标签：“不拥挤 · 24 km/h · 正常营运”。
    - 新鲜度角标：“12 秒前更新”。

### 2.2 线路详情页：Konva.js 折返与直线动态报站屏（RouteBoard 核心视图）

针对长线路布局，支持**折返多行拓扑排布**与**直线贯通排布**自由切换：

```
[海子角] ──●───●───●───[🚌]───◎───┐ (第1行：从左向右)
                                  │ (平滑半圆弧 U-Turn)
┌──◎───●───★(次渠南)───●───●───●───┘ (第2行：从右向左)
│ (平滑半圆弧 U-Turn)
└──●───●───[🚌]───●───●───●──────► [古城西桥] (第3行：从左向右)
```

#### 2.2.1 布局与几何排布算法
- **响应式站点疏密计算**：
  - 依据屏幕宽度与站名排版间距，动态计算单行容纳的站点数量：屏幕越窄显示的站点越少（移动端竖屏每行 4~5 站，间距充裕；桌面 PC 宽屏每行 10~12 站，保持工业大屏感）。
  - 折返模式下：奇数行自左向右，偶数行自右向左，行与行之间通过切向平滑的 180° 半圆弧衔接。
  - 直线模式下：全线沿单一大轴贯通展开，支持单指拖拽流畅滑行与聚焦定位。
- **大屏/横屏模式自适应**：
  - 在横屏、平板或宽屏桌面下，保持高密度大屏排布；在竖屏手机下采用大间距疏密自适应模式。

#### 2.2.2 视觉图层拆分（Konva.js Layering）
1. **轨道层（Track Layer）**：
   - 基础深色冷灰底轨。
   - 已过路段为暗灰，未过路段为电光青蓝发光轨道。
   - 折返处渲染圆润 U-Turn 弯道，线宽保持一致。
2. **站点节点层（Station Layer）**：
   - 普通站点：实心发光圆点，站点文字竖向或斜向排列在轨道外侧。
   - 换乘枢纽站：带同心外环的双重圆点，附带地铁换乘徽标（如“换乘 7号线”）。
   - 离我最近站（Current Stop）：金色发光地标圆点，带有外扩的水波纹扩散动效（Ripple Wave）。
   - 目标下车站（Destination）：终点旗帜标记与强调发光环。
3. **列车动态层（Vehicle Layer）**：
   - 拟物化机车图元。
   - 拥挤度色彩映射：绿色（舒适）、黄色（适中）、红色（拥挤）。
   - 沿线方向自动对齐：车辆行驶至直线路段保持水平姿态；行驶至两端 U-Turn 弯道时，车身随圆弧曲率平滑旋转朝向，保证运动逼真顺滑。
   - 车辆悬浮气泡：标注即时速度（如 `28 km/h`）与车辆代号。
4. **视口交互（Camera & Viewport）**：
   - 支持多点触控缩放（Pinch-Zoom）与上下/左右平滑拖拽。
   - 提供“聚焦目标站”快捷浮动按钮，一键缓动居中至离我最近站与前行来车之间。

### 2.3 站台起降大屏（Platform Aggregator View）
- 适用场景：用户已身处站台（如“次渠南”或“万盛南街西口”），附近有多条线路可选。
- 视觉形态：机场/高铁站风格的实时起降时刻表（翻牌动效/发光行）。
- 信息维度：
  - 线路编号（如 913、T12、T68）。
  - 开往方向（终点站名）。
  - 倒计时到达（按耗时最短由小到大排序：**2 分钟** > **5 分钟** > **11 分钟**）。
  - 剩余站数、距离、车辆拥挤度。

### 2.4 玄关 / 桌面看板模式（Kiosk Mode）
- 面向淘汰手机、iPad、横屏副屏挂载。
- 调用 Web Wake Lock API（`navigator.wakeLock.request('screen')`）保持屏幕常亮。
- 多线路纵向平铺并行渲染，整屏尽览。
- 深夜（00:00~05:00）非运营期自动切入超暗待机屏保模式，降低能耗并保护屏幕。

---

## 3. 核心算法与数据处理机制

### 3.1 航位推算平滑插值（Dead Reckoning）
上游接口拉取频率为 15~30 秒，前端必须消除车辆瞬移：
1. **运动估算**：
   - 上游单车数据包含：`currentOrder`（当前/刚过站序）、`speed`（米/秒）、`distanceToWaitStn`（距目标站米数）。
   - 帧循环（`requestAnimationFrame`）中，根据 $Distance(t) = Distance(0) + \int speed \cdot dt$ 线性更新车辆沿拓扑轨迹（含直线与折返圆弧）的几何位置。
   - 若推算已接近下一站进站位，车辆自动做缓动减速并停靠，杜绝因网络延迟导致的虚假“越站”跑偏。
2. **快照矫正（Correction Tween）**：
   - 新快照到达后，比对推算位置与最新位置。若存在偏差，在 500ms 内执行 Cubic-Bezier 缓动修正对齐，维持运动视觉连贯。

### 3.2 通勤情境自适应规则（Smart Context）
- 用户可配置 `Home` 坐标/车站 与 `Work` 坐标/车站。
- **时间与位置判定**：
  - 06:30 ~ 11:30：判定为上班方向，自动筛选开往工作地路线，目标站高亮为公司站。
  - 17:00 ~ 22:00：判定为下班方向，自动筛选返程路线，目标站高亮为家附近站。
  - 其他时段：依据 GPS 定位测距，自动匹配沿线距离当前位置物理半径最小的车站作为目标站。

### 3.3 地铁时刻表推演引擎（Subway Headway & Schedule Engine）
基于北京地铁无公开实时列车位置 API 的现状：
1. **双排班表管理**：
   - 严格分离工作日表（`workday`）与双休日表（`weekend`）。
   - **核心北京规则**：法定调休补班的周六日，**依然强制执行双休日时刻表**（北京地铁按周末客流排班惯例）。
2. **虚拟区间列车推演**：
   - 根据两端始发站与关键节点发车时刻表，结合站间平均运行时长（2~3 分钟/区间），推导当前时刻整条线路上正在区间运行的列车虚拟位置，标注“时刻表推算车”。

### 3.4 坐标纠偏与标准化
- 不同上游数据源可能返回 `WGS-84` 原始卫星坐标或国标 `GCJ-02` 坐标。
- 服务端及 `packages/transit-adapter` 内置高性能坐标转换算法，所有落库与下发前端的坐标统一标准化为 `GCJ-02`。

---

## 4. 可插拔数据源架构与服务容灾

### 4.1 适配器体系设计
通过策略模式（Strategy Pattern）与责任链（Fallback Chain）解耦上游数据源变更风险：

```
                    ┌─────────────────────────┐
                    │      WebSocket / REST   │
                    └────────────▲────────────┘
                                 │ 标准 DTO
                    ┌────────────┴────────────┐
                    │  Transit Aggregator     │ (服务端统一缓存 15-20s, 熔断器)
                    └────────────▲────────────┘
                                 │
     ┌───────────────────────────┼───────────────────────────┐
     │                           │                           │
┌────┴───────────────┐  ┌────────┴──────────────┐  ┌─────────┴─────────────┐
│  ChelaileAdapter   │  │   ApiZeroAdapter      │  │ SubwayScheduleEngine  │
│  (主源 · 秒级)      │  │   (兜底 · 分钟级)     │  │ (时刻表推演模型)       │
└────────────────────┘  └───────────────────────┘  └───────────────────────┘
```

1. **统一接口定义（`packages/transit-adapter`）**：
   - `searchLine(keyword: string, city: string): Promise<TransitLineSummary[]>`
   - `getLineDetail(lineId: string, direction: number): Promise<NormalizedLineDetail>`
   - `getLiveBuses(lineId: string, direction: number): Promise<NormalizedLiveBus[]>`
2. **主备自动降级策略**：
   - 采用多通道数据源自适应降级体系。
   - 严格规避死路：优先通过 `lineId` 查询在途车，规避部分城市不支持站点反查的限制。
   - 若主源连续异常，自动降级为备用热备数据源，并通过终点站名校准 `direction` 语义翻转问题。
   - 降级发生时，数据包携带 `isDegraded: true`，前端优雅降级提示，保障服务高可用。

### 4.2 共享缓存与连接复用机制
- 严禁客户端直连第三方交通数据源。
- 服务端设立基于内存的高频短效缓存（TTL 15~20 秒）。
- **WebSocket 频道广播模型**：多客户端同时查看 913 时，服务端仅由单一定时器向第三方拉取数据，再多播下发给订阅房间，避免触发上游风控封禁。无客户端监听时自动暂停拉取。

---

## 5. 技术栈与工程架构规范

### 5.1 仓库架构
采用 `pnpm` monorepo 架构：

```
real-time-transport/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── eslint.config.ts
├── docs/
│   └── PRD.md
├── packages/
│   ├── shared/                # Zod 契约、TS 类型定义、DTO、公共工具
│   └── transit-adapter/       # 可插拔数据源适配器包、加解密引擎、坐标转换
└── apps/
    ├── web/                   # 前端 (Vue 3, Vite 8, Tailwind CSS 4, Pinia 4, Konva)
    └── server/                # 后端 (Node 22, Fastify 5, WebSockets, PostgreSQL 18)
```

### 5.2 技术栈版本与工具链
- **Node.js**: `>=22`（支持 `--env-file`）
- **Package Manager**: `pnpm`
- **前端栈（`apps/web`）**：
  - `vue`: `^3.5`（全量 `<script setup lang="ts">`）
  - `vite`: `^8.2`
  - `tailwindcss`: `^4.3`（`@tailwindcss/vite`）
  - `pinia`: `^4.0`
  - `konva`: `^10.0` + `vue-konva`: `^4.0`（Canvas 核心拓扑动效引擎）
  - `@lucide/vue`: 扁平化图标
  - 无 i18n 依赖（文案全部硬编码中文）
- **后端栈（`apps/server`）**：
  - `fastify`: `^5.11`
  - `@fastify/websocket`: 全双工推送车况与到站事件
  - `pg`: `^8.22`（PostgreSQL 18 驱动）
  - `zod`: `^4.4`（端到端校验）
  - `pino`: 结构化高性能日志
- **数据源适配栈（`packages/transit-adapter`）**：
  - 原生 `fetch` + `node:crypto`（MD5、AES-256-ECB）
  - 自动流式 gzip / brotli 解压缩

---

## 6. 数据库模型设计（PostgreSQL 18）

负责个性化配置持久化与静态站点元数据长效缓存：

```sql
-- 1. 用户关注线路
CREATE TABLE user_favorite_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL DEFAULT 'default_user',
    line_id VARCHAR(64) NOT NULL,
    line_name VARCHAR(64) NOT NULL,
    preferred_direction INT NOT NULL DEFAULT 0,
    pinned_station_id VARCHAR(64),
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 通勤情境预设 (早晚高峰规则)
CREATE TABLE user_commute_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL DEFAULT 'default_user',
    profile_name VARCHAR(32) NOT NULL,
    target_line_ids TEXT[] NOT NULL,
    target_station_name VARCHAR(64),
    active_time_start TIME NOT NULL,
    active_time_end TIME NOT NULL,
    direction_rule INT NOT NULL DEFAULT 0
);

-- 3. 静态线路与站点元数据缓存 (避免高频重复拉取站名和坐标)
CREATE TABLE cached_transit_lines (
    line_id VARCHAR(64) PRIMARY KEY,
    city_code VARCHAR(16) NOT NULL DEFAULT '027',
    line_name VARCHAR(64) NOT NULL,
    direction INT NOT NULL,
    start_stop_name VARCHAR(64) NOT NULL,
    end_stop_name VARCHAR(64) NOT NULL,
    stops_json JSONB NOT NULL,
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7. 分阶段实施规划（Roadmap）

| 阶段 | 核心任务 | 交付验证标准 |
|---|---|---|
| **Phase 1: 契约层与数据源适配器** | 1. 搭建 pnpm monorepo 与 `packages/shared`<br>2. 编写 `packages/transit-adapter`：多通道公交聚合、通用地铁时刻表推演引擎<br>3. 坐标转换工具库（WGS84 ↔ GCJ02） | 单测跑通，使用 913、T12、T68 种子线路成功拉取站序与在途车实时列表 |
| **Phase 2: 服务端管道与广播系统** | 1. Fastify 5 启动与 WebSocket Room 建立<br>2. 聚合轮询调度器与 20s 共享缓存策略<br>3. PostgreSQL 18 迁移与收藏数据接口 | 客户端连接 WS 订阅 913，服务端按设定周期稳定推送标准化增量数据 |
| **Phase 3: 前端 Konva 拓扑报站引擎** | 1. Vue 3 + Tailwind CSS 4 移动端基础框架<br>2. 基于 Konva.js 封装折返与直线双排布 `RouteBoard` 组件（自适应疏密分行、U-Turn 弯道与动效）<br>3. 航位推算平滑插值（Dead Reckoning）与列车姿态转向 | 手机端打开 913 详情页，超长 57 站整洁排成分行或直线，车辆沿轨道平滑行进，不越站不瞬移 |
| **Phase 4: 场景功能与开源发布** | 1. 首页微缩卡片流与上下行切换<br>2. 站台聚合起降大屏与玄关 Kiosk 模式（Wake Lock）<br>3. 通勤情境自适应识别<br>4. Docker Compose 编排与开源 README 文档交付 | 完整端到端验证通过，符合 0 错误 0 警告标准，开箱即用 |
