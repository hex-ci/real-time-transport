/**
 * 浏览器 e2e 的入口：`pnpm test:e2e`。
 *
 * 它自己起后端（25282）与前端（25281）、自己建/清专用测试库（`transit_test_e2e`）、
 * 自己用 HTTP 接口造夹具，跑完把自己起的两台服务杀掉 —— 开发机上的开发服务与开发库一格都不碰。
 *
 * 用法：
 *   node tests/e2e/run.mjs                    # 全部六个场景
 *   node tests/e2e/run.mjs --only 首页卡片     # 只跑一个（红灯演示也用这条路径）
 *   node tests/e2e/run.mjs --red 首页卡片      # 故意改坏被测行为，证明这个场景真的会红，再复原
 *   RED_MUTATION_NO_RESTORE=1 node ... --red   # 调试用：改坏后不复原（绝不会被 CI 用）
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT, PORTS, WEB_ORIGIN, API_ORIGIN,
  ensureDatabase, startStack, stopStack, openBrowser, closeBrowser, listeningPids,
  createChecker, delay, cli, goto, pageEval, api,
} from './harness.mjs'
import { seedFixtures } from './fixtures.mjs'
import { MUTATIONS } from './mutations.mjs'
import * as home from './scenarios/home.mjs'
import * as lineDetail from './scenarios/line-detail.mjs'
import * as platform from './scenarios/platform.mjs'
import * as commuteChain from './scenarios/commute-chain.mjs'
import * as settings from './scenarios/settings.mjs'
import * as mobile from './scenarios/mobile.mjs'

const SCENARIOS = [home, lineDetail, platform, commuteChain, settings, mobile]

// ---------------------------------------------------------------- 命令行

const args = process.argv.slice(2)
function flagValue(name) {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

const only = flagValue('--only')?.split(',').map(s => s.trim()).filter(Boolean)
const red = flagValue('--red')
const DEV_SERVER_PORTS = [25181, 25182]

// ---------------------------------------------------------------- 打印：库、端口、版本

function packageVersion(specifier) {
  for (const base of [join(REPO_ROOT, 'node_modules'), join(REPO_ROOT, 'apps/server/node_modules'), join(REPO_ROOT, 'apps/web/node_modules')]) {
    const file = join(base, specifier, 'package.json')
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8')).version
    }
    catch {
      // 下一个候选路径
    }
  }
  return '?'
}

async function printHeader(db) {
  const playwrightCli = (await cli(['--version'], { allowFailure: true })).out.trim()
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const lines = [
    '浏览器端到端',
    `  库：PostgreSQL ${db.serverVersion}（容器 ${db.container}）· 测试库 ${db.name} · 迁移 ${db.migrations} 条`,
    `  版本：Node ${process.version} · ${manifest.packageManager} · Vue ${packageVersion('vue')} · Vite ${packageVersion('vite')} · Fastify ${packageVersion('fastify')} · Pinia ${packageVersion('pinia')} · Konva ${packageVersion('konva')} · ${playwrightCli || 'playwright-cli ?'}`,
    `  端口：后端 ${PORTS.server} · 前端 ${PORTS.web}（${WEB_ORIGIN} → ${API_ORIGIN}）`,
    `  场景：${SCENARIOS.map(s => s.name).join(' / ')}`,
  ]
  console.log(lines.join('\n'))
  console.log('')
}

// ---------------------------------------------------------------- 红灯演示

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 把被测行为改坏、跑一次这个场景、再复原，并核对文件回到原来的哈希。
 *
 * 「改坏」只动一个地方（`mutations.mjs` 里那一条），复原走 `finally`：
 * 中途抛错也不会把一个改坏的工作区留给人。
 */
async function redDemo(scenario, context) {
  const mutation = MUTATIONS[scenario.name]
  if (!mutation) throw new Error(`场景「${scenario.name}」没有红灯演示的改法`)

  const file = join(REPO_ROOT, mutation.file)
  const original = readFileSync(file)
  const before = sha256(file)
  const mutated = original.toString('utf8')
  if (!mutated.includes(mutation.find)) {
    throw new Error(`红灯演示找不到要改的那段代码（${mutation.file}）：${mutation.find.slice(0, 60)}`)
  }

  console.log(`\n--- 红灯演示：${scenario.name} ---`)
  console.log(`  改坏 ${mutation.file}`)
  console.log(`  改动 ${JSON.stringify(mutation.find.slice(0, 70))} → ${JSON.stringify(mutation.replace.slice(0, 70))}`)
  let result
  let restoreError = null
  try {
    writeFileSync(file, mutated.replace(mutation.find, mutation.replace))
    await delay(800)
    const started = Date.now()
    result = await runScenario(scenario, context, { expectFailure: true })
    result.durationMs = Date.now() - started
  }
  finally {
    // 复原走 finally：中途抛错也不会把一个改坏的工作区留给人。异常在这里只记下、出来再抛，
    // 因为在 finally 里抛会盖掉原来那个错误。
    if (!process.env.RED_MUTATION_NO_RESTORE) {
      writeFileSync(file, original)
      const after = sha256(file)
      console.log(`  复原后 sha256 ${after === before ? '一致' : '不一致！'}（${after.slice(0, 12)}…）`)
      if (after !== before) restoreError = new Error(`复原失败：${mutation.file} 的哈希变了`)
    }
    await delay(500)
  }
  if (restoreError) throw restoreError
  return { scenario: scenario.name, mutation, result }
}

// ---------------------------------------------------------------- 跑场景

async function runScenario(scenario, context, { expectFailure = false } = {}) {
  const check = createChecker()
  const started = Date.now()
  let error = null
  try {
    // 每个场景都从一次干净的页面开始：上一个场景留下的 localStorage 与滚动位置不该渗进来。
    await goto(`${WEB_ORIGIN}/`)
    await pageEval('(() => { localStorage.clear(); sessionStorage.clear(); return "cleared" })()')
    await scenario.run({
      ...context,
      check: check.check.bind(check),
      equal: check.equal.bind(check),
      note: check.note.bind(check),
    })
    check.throwIfFailed(scenario.name)
  }
  catch (err) {
    error = err
  }
  const durationMs = Date.now() - started

  if (expectFailure) {
    const failed = Boolean(error)
    console.log(`  ${failed ? '✓' : '✗'} 场景在改坏后${failed ? '失败了（这正是要看的）' : '居然还是绿的 —— 这条断言无法区分行为'}`)
    if (failed) {
      const detail = String(error.message).split('\n').filter(line => line.trim().startsWith('✗') || !line.startsWith('  ')).slice(0, 4)
      for (const line of detail) console.log(`      ${line.trim().slice(0, 200)}`)
    }
    return { failed, error, durationMs }
  }

  for (const note of check.notes) console.log(`  · ${note}`)
  if (error) {
    console.log(`  ✗ ${scenario.name}（${durationMs}ms）`)
    console.log(String(error.message).split('\n').map(line => `      ${line.trim()}`).join('\n'))
    console.log(String(error.stack).split('\n').slice(1, 4).map(line => `      ${line.trim()}`).join('\n'))
  }
  else {
    console.log(`  ✓ ${scenario.name}（${durationMs}ms）`)
  }
  return { failed: Boolean(error), error, durationMs }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const wallStart = Date.now()
  const db = await ensureDatabase()
  await printHeader(db)

  const stack = await startStack({ simulation: true })
  const browserStarted = Date.now()
  let failures = 0
  let favouritesCount
  try {
    console.log(`  后端已就绪（simulation=${stack.health.simulation}），前端已就绪，启动耗时 ${Date.now() - browserStarted}ms`)
    let context = { fixtures: null }
    const started = Date.now()
    context.fixtures = await seedFixtures()
    console.log(`  夹具就绪（${Date.now() - started}ms）：${context.fixtures.favorites.a.line.lineName} / ${context.fixtures.favorites.b.line.lineName} / ${context.fixtures.favorites.c.line.lineName}，链路 ${context.fixtures.chains.morning.name}、${context.fixtures.chains.evening.name}`)
    console.log('')

    const entries = only ? SCENARIOS.filter(s => only.includes(s.name)) : SCENARIOS
    if (entries.length === 0) throw new Error(`--only 没匹配到任何场景：${JSON.stringify(only)}`)

    if (red) {
      const targets = red === 'all' ? entries : entries.filter(s => s.name === red)
      if (targets.length === 0) throw new Error(`--red 没匹配到场景：${red}`)
      const results = []
      for (const scenario of targets) {
        // 每个红灯演示都重新造一次夹具：场景会写数据（上车点、链路顺序），
        // 带着上一个场景留下的状态去跑，红可能来自前提而不是被改坏的那一处。
        context.fixtures = await seedFixtures()
        await openBrowser(`${WEB_ORIGIN}/`)
        const demo = await redDemo(scenario, context)
        results.push(demo)
      }
      console.log('\n红灯演示汇总：')
      for (const demo of results) {
        console.log(`  ${demo.result.failed ? '红' : '仍绿'}  ${demo.scenario}（${demo.result.durationMs}ms）—— ${demo.mutation.file}`)
      }
      if (results.some(demo => !demo.result.failed)) failures = 1
    }
    else {
      await openBrowser(`${WEB_ORIGIN}/`)
      const startedAll = Date.now()
      for (const scenario of entries) {
        const result = await runScenario(scenario, context)
        if (result.failed) failures += 1
      }
      console.log(`  六个场景合计 ${((Date.now() - startedAll) / 1000).toFixed(1)}s`)
    }

    // 夹具确实落在测试库里：用服务的 HTTP 接口读一次关注线路（服务还活着的时候读）。
    favouritesCount = (await api('/api/transit/favorites')).body?.data?.length ?? null
  }
  finally {
    await closeBrowser()
    stopStack(stack)
  }

  // 收尾自证：这两台是我起的，故不该再有人监听；开发机上的 25181/25182 不该被我碰到。
  await delay(1200)
  const residual = []
  for (const [label, port] of [['后端', PORTS.server], ['前端', PORTS.web]]) {
    const listeners = await listeningPids(port)
    if (listeners.length > 0) residual.push(`${label} ${port}：${listeners.join(' | ')}`)
  }
  for (const port of DEV_SERVER_PORTS) {
    const listeners = await listeningPids(port)
    console.log(`  开发服务 ${port}：${listeners.length > 0 ? '仍在（未被我触碰）' : '当前没有在跑'}`)
  }
  if (residual.length > 0) {
    console.log(`\n收尾失败，仍有进程占用：\n  ${residual.join('\n  ')}`)
    failures += 1
  }
  else {
    console.log(`  收尾：${PORTS.web} 与 ${PORTS.server} 上已无监听进程`)
  }

  // 夹具确实落在测试库里：用服务的 HTTP 接口读一次关注线路。
  console.log(`  测试库里的关注线路：${favouritesCount ?? '?'} 条（库 ${db.name}）`)
  console.log(`  总耗时 ${((Date.now() - wallStart) / 1000).toFixed(1)}s`)

  console.log(failures === 0 ? '\ne2e 全部通过' : `\ne2e 有 ${failures} 项未通过`)
  return failures === 0 ? 0 : 1
}

process.exitCode = await main()
