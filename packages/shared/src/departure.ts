import type { CatchDecision } from './schemas/gis.js'

/**
 * F1 的出门结论 ——「打开即结论」。
 *
 *   walk = 锚点 → 站台的真实步行耗时（服务端已缓存）
 *   T    = 站台等待容忍值（默认 3 分钟，同时是安全边际）
 *   eta₁ = 最近一班到站分钟
 *     eta₁ - walk ≤ T  → 现在就走
 *     否则             → (eta₁ - walk - T) 分钟后出门
 *     错过代价         = eta₂ - eta₁
 *
 * 纯函数：两个真正带风险的边界（容忍值本身、以及这班车开始赶不上的那一点）只在这里判定一次，
 * 由测试而非阅读 UI 保证。服务端解析锚点并计价步行，web 渲染结论，两侧都不自行计算。
 * 零编造：输入全为真实上游数据或具名容差，算不出结论就返回 `null` 而不猜 ——
 * 本文件里没有步行速度、没有假定距离、也没有任何默认 ETA。
 */

/**
 * T：用户在站台愿意等待的分钟数，同时也是安全边际。
 * 提前 T 分钟出发可吸收「车早到」与路上变数。它是具名默认值而非设置项：
 * 每个入口都以参数接收（故 F1 要求的可配置成立），落库需要另写迁移。
 */
export const DEFAULT_WAIT_TOLERANCE_MINUTES = 3

/**
 * 实时读数最多可以有多旧（秒）仍足以支撑结论。
 * 服务端 18 秒轮询、聚合器缓存同长，故新鲜答案总在 ~40 秒内；此值为六次漏轮询，
 * 即上游中断而非抖动。越过它即扣留参考行 —— 拿过期数字说「现在就走」比什么都不说更糟（F1 边界）。
 */
export const STALE_ARRIVAL_SECONDS = 120

/** F1 复用的三种结论：`CatchDecision` 去掉 `unknown` —— 那是关于数据的陈述，不是关于出门的。 */
export type DepartureState = Exclude<CatchDecision, 'unknown'>

/**
 * 到站数字的可信度。只有 `ok` 支持结论：
 * 数据过期或降级时 F1 扣留结论，因为建立在旧读数上的自信「现在就走」正是本功能会引入的失效模式。
 */
export type DepartureTrust = 'ok' | 'stale' | 'degraded'

/** F2 的两个已保存位置。 */
export type AnchorLeg = 'home' | 'work'

/** 已存储的通勤时段：决定哪个锚点代表「你现在在哪」。 */
export interface CommuteHours {
  morningStart: string
  morningEnd: string
  eveningStart: string
  eveningEnd: string
}

export interface DepartureAdviceInput {
  /**
   * 锚点 → 站台的真实步行耗时（秒，路径服务实测值）。
   * 未计价出步行路线时为 `null` —— 步行正是比较项，缺了就没有结论。
   */
  walkSeconds: number | null
  /**
   * 下一班车抵达本站台的秒数；`0` 表示车已在站台（对仍在锚点的人即已错过）。
   * 无车在途时为 `null`。
   */
  nextArrivalSeconds: number | null
  /**
   * 再下一班的秒数，用于错过代价。可选：没有第二班时结论仍成立，只是代价未知。
   */
  followingArrivalSeconds?: number | null
  /** T。默认取 `DEFAULT_WAIT_TOLERANCE_MINUTES`。 */
  waitToleranceMinutes?: number
  /** 到站数字的新鲜度。默认 `ok`。 */
  trust?: DepartureTrust
}

/** 无论给出哪种结论都携带的字段。 */
export interface DepartureAdviceFields {
  /** 行内展示的步行分钟数（「步行 6 分」）。 */
  walkMinutes: number
  /** 按到站列表展示口径给出的下一班分钟数。 */
  nextArrivalMinutes: number
  /** eta₂ - eta₁：错过这班车的代价；eta₂ 未知时为 `null`。 */
  missCostMinutes: number | null
}

/**
 * 结论，以及各结论自己真正携带的字段。
 * `leaveInMinutes` 刻意做成按结论分支的字段，而不是一个可空数字：
 * `comfortable` 必有出门时刻、`missed` 必无，故行程不可能渲染出「null 分钟后出门」——
 * 把缺失值装扮成答案，是本功能唯一不可以做的事。
 *
 * - `comfortable` — 余量大于用户在站台的容忍值：可以等。
 * - `hurry`       — 余量落在容忍值之内：现在就走，否则赶不上。
 * - `missed`      — 车在步行走完前就到；没有出门时刻可给。
 */
export type DepartureAdvice
  = | (DepartureAdviceFields & { state: 'comfortable', leaveInMinutes: number })
    | (DepartureAdviceFields & { state: 'hurry', leaveInMinutes: 0 })
    | (DepartureAdviceFields & { state: 'missed', leaveInMinutes: null })

/**
 * 服务端为某个站台解析出的结果，或 `null`。
 * F1 对步行耗时、到站数据或锚点缺失的站台不给参考行，且三种答案刻意不合并：
 *
 * - `advice`       真实步行 + 真实车次 → 给出结论。
 * - `anchor-unset` 本段锚点从未保存，故该行指向设置页。与「步行缺失」不同：
 *                  那是关于已存储行的事实，在步行仅仅是失败时用它就是对用户数据的谎报。
 * - `null`         无锚点代表「你现在在哪」（两个通勤时段之外）、无步行路线、无车可赶，
 *                  或到站数据过期/降级 → 该行缺席，绝不装扮成「不用着急」。
 */
export type DepartureReference
  = | { status: 'advice', anchor: AnchorLeg, advice: DepartureAdvice }
    | { status: 'anchor-unset', anchor: AnchorLeg }

/**
 * 整分步行时长，下限为 1。
 * 20 秒也是走路，渲染成「步行 0 分」会读成完全没走；这个下限同时偏向比较中安全的一侧。
 */
export function walkingMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60))
}

/**
 * 到车整分时长 —— 与到站列表同一规则，故结论取自用户真正读到的数字。
 * `0` 表示正进站，30 秒读作 1 分钟（绝不读作 0）。
 */
export function arrivalMinutes(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60))
}

/**
 * 一条**到站行**声明的分钟数；该行未声明时为 `null` —— 唯一定夺这两种情况的地方。
 * `ArrivalRowSchema` 使 `etaSeconds` 可选，而该缺失是数据而非待补的空白：
 * 把 `undefined` 画成分钟，与已被删除的推算值是同一个谎，只是换了一层。
 * `isAtStation` 先答且答 `0`：服务端用 `etaSeconds: 0` 计价该状态（上游自己声明车已在此），
 * 读成「没有分钟」会藏起一辆正停在站台上的车。
 * 非有限或负的时长不是时长，答 `null`，而不是「NaN分」或「-1分」。
 */
export function statedArrivalMinutes(
  row: { etaSeconds?: number | null, isAtStation?: boolean },
): number | null {
  if (row.isAtStation) return 0
  if (typeof row.etaSeconds !== 'number' || !Number.isFinite(row.etaSeconds) || row.etaSeconds < 0) {
    return null
  }
  return arrivalMinutes(row.etaSeconds)
}

/**
 * 出门结论；数据无法诚实支撑时为 `null`。
 * 比较在**取整后的展示分钟**上进行，故结论与它旁边的数字不可能互相矛盾
 * （拿原始秒去比展示分钟，在容忍值附近就是一个随时会发生的 1 分钟之谎）。
 */
export function departureAdvice(input: DepartureAdviceInput): DepartureAdvice | null {
  if ((input.trust ?? 'ok') !== 'ok') return null
  if (input.walkSeconds === null || input.nextArrivalSeconds === null) return null

  const walkMinutes = walkingMinutes(input.walkSeconds)
  const nextArrivalMinutes = arrivalMinutes(input.nextArrivalSeconds)
  const tolerance = input.waitToleranceMinutes ?? DEFAULT_WAIT_TOLERANCE_MINUTES

  const following = input.followingArrivalSeconds
  const missCostMinutes = typeof following === 'number'
    ? arrivalMinutes(following) - nextArrivalMinutes
    : null

  const slack = nextArrivalMinutes - walkMinutes

  // 车在步行走完前就到：这班已经错过。
  if (slack < 0) {
    return { state: 'missed', walkMinutes, nextArrivalMinutes, leaveInMinutes: null, missCostMinutes }
  }
  // eta₁ - walk ≤ T：现在就走。边界取闭区间 —— 恰好等于 T 仍在用户自己的容忍值之内，
  // 故 现在就走 才是诚实的答案。
  if (slack <= tolerance) {
    return { state: 'hurry', walkMinutes, nextArrivalMinutes, leaveInMinutes: 0, missCostMinutes }
  }
  // 余量大于用户在站台的容忍值：可以等。
  return {
    state: 'comfortable',
    walkMinutes,
    nextArrivalMinutes,
    leaveInMinutes: slack - tolerance,
    missCostMinutes,
  }
}

/**
 * `hhmm`（本地 `HH:MM`）时刻「你在哪」对应的已保存锚点。
 * 早高峰 → 家，晚高峰 → 公司。两个时段之外没有任何锚点代表用户位置，
 * F1 的做法是不给结论，而不是挑一个 —— 用对用户位置的猜测搭出的参考行比缺失更糟。
 * 两端取闭区间，与通勤档已用的时段规则一致，故 06:30 / 11:30 处卡片模式与锚点不会分歧。
 */
export function anchorLegAt(hhmm: string, hours: CommuteHours): AnchorLeg | null {
  if (hhmm >= hours.morningStart && hhmm <= hours.morningEnd) return 'home'
  if (hhmm >= hours.eveningStart && hhmm <= hours.eveningEnd) return 'work'
  return null
}

/**
 * 一次到站读数的可信度，由产生方式与存放时长决定。
 * `isDegraded` 是聚合器标注的「兜底源作答」；它与超龄读数都会压制结论。
 * 纯函数，故规则本身由测试覆盖，而不只是在恰好调用它的那个分支里。
 */
export function arrivalTrust(params: {
  isDegraded?: boolean
  updatedAt: number
  /** 可注入时钟，便于测试年龄边界。 */
  now?: number
}): DepartureTrust {
  if (params.isDegraded) return 'degraded'
  const ageMs = (params.now ?? Date.now()) - params.updatedAt
  return ageMs > STALE_ARRIVAL_SECONDS * 1000 ? 'stale' : 'ok'
}
