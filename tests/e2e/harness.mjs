/**
 * 浏览器 e2e 的基建：专用测试库、自起自停的两台服务，以及 playwright-cli 的封装。
 *
 * 三条硬约束，后续任何场景都不得绕过：
 *
 *  - 库名固定 `transit_test_e2e`，且必须与开发库不同名 —— 开工前的闸比对根 `.env` 里的库名，
 *    相同就拒绝启动；连接串只在本进程内传递，任何地方都不打印。
 *  - 端口固定：后端 25282、前端 25281。这两个之外的一律不碰（尤其不碰开发机上的 25181/25182）。
 *  - 只杀自己起的进程：spawn 时 detached，收尾时按进程组杀，绝不按端口反查（那会杀掉别人）。
 *
 * playwright-cli 是外部命令（不自带 playwright 依赖）：命令一律走本文件的 `cli()`，
 * 浏览器会话名固定，使一次跑动只留一个浏览器、收尾必定关掉。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const PORTS = { server: 25282, web: 25281 }
export const E2E_DB = 'transit_test_e2e'
export const DB_CONTAINER = 'real-time-transport-postgres'
/** 开发机上的开发库名；e2e 库必须与它不同名。 */
const DEV_DB = 'transit'

export const WEB_ORIGIN = `http://127.0.0.1:${PORTS.web}`
export const API_ORIGIN = `http://127.0.0.1:${PORTS.server}`
export const SESSION = 'rt-e2e'

const PLAYWRIGHT_CLI = process.env.PLAYWRIGHT_CLI ?? 'playwright-cli'

// ---------------------------------------------------------------- 子进程小工具

/** 跑一个命令，拿 stdout；失败时把 stderr 一并放进错误里（凭据不进命令行，故可整段带出）。 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) resolve({ code, out, err })
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}\n${err || out}`))
    })
  })
}

// ---------------------------------------------------------------- 库

/**
 * 开发库里那一条连接串（从根 `.env` 读；环境变量优先）。
 * 只在内存里传递：本文件的任何输出都不得包含它。
 */
function devDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const envPath = join(REPO_ROOT, '.env')
  if (!existsSync(envPath)) throw new Error(`找不到 ${envPath}：没法知道数据库在哪`)
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim()
  }
  throw new Error('根 .env 里没有 DATABASE_URL')
}

/** e2e 库的连接串，以及它的三个可打印部件（主机、端口、库名）。 */
export function e2eDatabase() {
  const url = new URL(devDatabaseUrl())
  const devName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (devName === E2E_DB) throw new Error(`拒绝运行：e2e 库名与开发库同名（${E2E_DB}）`)
  if (!E2E_DB.includes('_test')) throw new Error(`拒绝运行：e2e 库名必须以 _test 结尾（${E2E_DB}）`)
  if (E2E_DB === DEV_DB) throw new Error('拒绝运行：e2e 库名等于开发库名')
  url.pathname = `/${E2E_DB}`
  return {
    url: url.toString(),
    host: url.hostname,
    port: url.port || '5432',
    name: E2E_DB,
    devName,
    user: decodeURIComponent(url.username),
  }
}

async function psql(database, sql) {
  const db = e2eDatabase()
  const { out } = await run('docker', [
    'exec', DB_CONTAINER, 'psql', '-U', db.user, '-d', database, '-tAc', sql,
  ])
  return out.trim()
}

/** 建库（缺则建）+ 跑迁移（幂等），再把业务表清空 —— 每次跑动都从同一份空库开始。 */
export async function ensureDatabase() {
  const db = e2eDatabase()
  const running = await run('docker', ['inspect', '-f', '{{.State.Running}}', DB_CONTAINER], { allowFailure: true })
  if (!running.out.includes('true')) {
    throw new Error(`容器 ${DB_CONTAINER} 没有运行；先跑 docker compose up -d`)
  }

  const exists = await psql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${db.name}'`)
  let created = false
  if (exists !== '1') {
    await psql('postgres', `CREATE DATABASE "${db.name}"`)
    created = true
  }
  // 迁移走仓库里那一条路径（与 pnpm test:db 同一个 migrate.ts），库名由 DATABASE_URL 决定。
  await run('pnpm', ['--filter', '@real-time-transport/server', 'exec', 'tsx', 'src/db/migrate.ts', 'up'], {
    cwd: REPO_ROOT,
    env: { DATABASE_URL: db.url },
  })

  await resetBusinessTables()
  const migrations = await psql(db.name, 'SELECT count(*) FROM _migrations')
  const serverVersion = await psql(db.name, 'SHOW server_version')
  return {
    host: db.host,
    port: db.port,
    name: db.name,
    container: DB_CONTAINER,
    created,
    migrations: Number(migrations),
    serverVersion: serverVersion.split(' ')[0],
  }
}

/**
 * 清空业务表：表名从 pg_tables 动态取，`_migrations` 除外（清它会让下一次迁移重放）。
 * 不走 pg_dump/恢复 —— 比 TRUNCATE 慢几个数量级，还会把它自己的状态一起搬运。
 *
 * 导出是给夹具用的：红灯演示每个场景都要重新造一次夹具，而「已关注」之类的唯一约束
 * 会让第二次种子长在第一次的数据上。
 */
export async function resetBusinessTables() {
  const db = e2eDatabase()
  const tables = await psql(db.name, 'SELECT tablename FROM pg_tables WHERE schemaname = \'public\' AND tablename <> \'_migrations\'')
  if (!tables) return
  const list = tables.split('\n').filter(Boolean).map(name => `"${name}"`).join(', ')
  if (!list) return
  await psql(db.name, `TRUNCATE ${list} CASCADE`)
}

// ---------------------------------------------------------------- 两台服务

/** 轮询健康检查，直到后端答 200 或超时。 */
async function waitForHealth(url, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json().catch(() => ({}))
      last = `HTTP ${res.status}`
    }
    catch (err) {
      last = String(err)
    }
    await delay(250)
  }
  throw new Error(`${what} 在 ${timeoutMs}ms 内没就绪：${last}`)
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** spawn 一台常驻服务：detached，好让收尾能整组杀掉（pnpm 会再起子进程）。 */
function spawnService(name, command, args, env) {
  const childEnv = { ...process.env }
  delete childEnv.VITEST
  childEnv.NODE_ENV = 'development'
  Object.assign(childEnv, env)

  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const service = { name, child, pid: child.pid, log: '', exited: false }
  const collect = (chunk) => {
    service.log += chunk
    if (service.log.length > 20000) service.log = service.log.slice(-20000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('exit', () => {
    service.exited = true
  })
  return service
}

function stopService(service) {
  if (!service || service.exited) return
  try {
    // 负号 = 整个进程组；pnpm 自己会再起 node，按 pid 单杀会留下孤儿占着端口。
    process.kill(-service.pid, 'SIGTERM')
  }
  catch {
    try {
      service.child.kill('SIGKILL')
    }
    catch { /* 已经没了 */ }
  }
}

/**
 * 起后端与前端，等两者就绪。前端端口必须与约定一致：vite 在端口被占时会顺延，
 * 而那会落到别人的端口上，故这里核对它自报的地址而不是等它自己挑一个。
 */
export async function startStack({ simulation = true } = {}) {
  const db = e2eDatabase()
  const server = spawnService('server', 'pnpm', [
    '--filter', '@real-time-transport/server', 'exec', 'tsx',
    '--env-file-if-exists=../../.env', 'src/index.ts',
  ], {
    PORT: String(PORTS.server),
    HOST: '127.0.0.1',
    DATABASE_URL: db.url,
    LOG_LEVEL: 'warn',
    TRANSIT_SIMULATION: simulation ? 'true' : 'false',
  })

  let health
  try {
    health = await waitForHealth(`${API_ORIGIN}/health`, 60_000, '后端')
  }
  catch (err) {
    stopService(server)
    throw new Error(`${err.message}\n--- 后端日志 ---\n${server.log}`, { cause: err })
  }

  const web = spawnService('web', 'pnpm', ['--filter', '@real-time-transport/web', 'dev'], {
    VITE_PORT: String(PORTS.web),
    VITE_SERVER_PORT: String(PORTS.server),
    VITE_HOST: '127.0.0.1',
  })

  try {
    await waitForWeb()
  }
  catch (err) {
    stopStack({ server, web })
    throw new Error(`${err.message}\n--- 前端日志 ---\n${web.log}`, { cause: err })
  }

  return {
    server,
    web,
    health,
    stop: () => stopStack({ server, web }),
  }
}

export function stopStack(stack) {
  stopService(stack.web)
  stopService(stack.server)
}

async function waitForWeb() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${WEB_ORIGIN}/`)
      if (res.ok) {
        const html = await res.text()
        if (html.includes('id="app"')) return
      }
    }
    catch {
      // 还没起来
    }
    await delay(300)
  }
  throw new Error(`前端在 ${WEB_ORIGIN} 上没就绪`)
}

/** 端口占用报告（收尾自证用）：只读，不杀任何东西。 */
export async function listeningPids(port) {
  const { out } = await run('ss', ['-ltnp'], { allowFailure: true })
  return out.split('\n').filter(line => line.includes(`:${port} `)).map(line => line.trim())
}

// ---------------------------------------------------------------- HTTP 夹具

/** 对后端的调用：场景的夹具、以及「接口载荷」的那一侧比较，都走这里。 */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  }
  catch {
    throw new Error(`${method} ${path} 的应答不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  return { status: res.status, body: json }
}

/** 断言 api() 成功，返回 data。 */
export async function apiData(path, options) {
  const res = await api(path, options)
  if (!res.body?.success) {
    throw new Error(`${options?.method ?? 'GET'} ${path} 失败：HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`)
  }
  return res.body.data
}

// ---------------------------------------------------------------- playwright-cli

/**
 * 一条 playwright-cli 命令。失败即抛，并把命令与输出一并带出 —— 场景里的每一步都是真的
 * 浏览器操作，静默失败会让后面的断言在错误的前提上跑。
 */
export async function cli(args, { allowFailure = false } = {}) {
  const full = [`-s=${SESSION}`, ...args]
  const result = await run(PLAYWRIGHT_CLI, full, { allowFailure: true, cwd: REPO_ROOT })
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`playwright-cli ${full.join(' ')} 退出码 ${result.code}\n${result.err || result.out}`)
  }
  return { code: result.code, out: result.out, err: result.err }
}

/**
 * `--raw eval`：在页面里求值并取回 JSON。
 *
 * CLI 把求值结果当成字符串再编码一次，故这里解两层：先解 CLI 的编码，若拿到的是字符串
 * 再解它一次（表达式自己返回 JSON 文本时），两次都不成才是普通字符串。
 */
export async function pageEval(expression, { arg } = {}) {
  const args = ['--raw', 'eval', expression]
  if (arg !== undefined) args.push(arg)
  const { out } = await cli(args)
  const text = out.trim()
  if (text === '') return null
  let value
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new Error(`页面求值的结果无法解析为 JSON：${text.slice(0, 300)}`)
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    }
    catch {
      return value
    }
  }
  return value
}

export async function openBrowser(url) {
  await cli(['open', url], { timeout: 120_000 })
}

export async function goto(url) {
  await cli(['goto', url])
}

export async function closeBrowser() {
  await cli(['close'], { allowFailure: true })
}

/**
 * 轮询一个页面侧的谓词，直到为真或超时。
 * 页面是异步渲染的，所以「等条件」永远是条件，不是固定睡眠。
 */
export async function waitFor(expression, { timeout = 15_000, interval = 300, what = expression } = {}) {
  return waitForValue(expression, value => value === true, { timeout, interval, what })
}

/** 同上，但谓词由调用方给：等一个值（文本、数组）而不是等 true。 */
export async function waitForValue(expression, predicate, { timeout = 15_000, interval = 300, what = expression } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await pageEval(expression)
    if (predicate(last)) return last
    await delay(interval)
  }
  throw new Error(`等待超时（${timeout}ms）：${what} —— 最后一次求值为 ${JSON.stringify(last)?.slice(0, 400)}`)
}

/**
 * 在页面里装一个 fetch 记录器：每一次请求的 url / method / 请求体 / 应答（解析后的 JSON）都记下来。
 *
 * 请求体级与「响应自身字段」级的断言只能这样拿到：它们是页面真的发出、真的收到的东西，
 * 而不是它在屏幕上显示的东西。包装只加记录，不改行为 —— 原来的 fetch 原样调用。
 *
 * 走 `addInitScript`（run-code）而不是就地替换 `window.fetch`：记录器必须活过导航，
 * 否则下一次 `goto` 之后它就是 undefined，而断言会以「读不到」而不是「行为不对」失败。
 * 装好之后要导航一次才生效（脚本在下一次文档创建时求值）。
 */
export async function installFetchRecorder() {
  await cli(['run-code', `async page => {
    await page.addInitScript(() => {
      const log = []
      window.__e2eFetch = log
      const original = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        const method = (init && init.method) || (typeof input === 'string' ? 'GET' : input.method) || 'GET'
        const entry = { url, method, requestBody: init && init.body ? String(init.body) : null }
        log.push(entry)
        const res = await original(input, init)
        try {
          entry.status = res.status
          entry.response = JSON.parse(await res.clone().text())
        }
        catch { /* 非 JSON 的应答不记录 */ }
        return res
      }
    })
  }`])
}

export async function recordedRequests() {
  return (await pageEval('JSON.stringify(window.__e2eFetch || [])')) ?? []
}

/** 页面收到过的某类应答（按 URL 子串筛），过滤与解构都在这里做一次。 */
export async function recordedResponses(substring) {
  return (await recordedRequests()).filter(entry => entry.url.includes(substring) && entry.response)
}

export async function clearRecordedRequests() {
  await pageEval('(() => { if (window.__e2eFetch) window.__e2eFetch.length = 0; return "cleared" })()')
}

// ---------------------------------------------------------------- 检查与报告

export function createChecker() {
  const failures = []
  const notes = []
  return {
    check(label, condition, detail) {
      if (condition) return true
      failures.push({ label, detail })
      return false
    },
    equal(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected)
      if (!ok) failures.push({ label, detail: `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}` })
      return ok
    },
    note(text) {
      notes.push(text)
    },
    get failures() { return failures },
    get notes() { return notes },
    throwIfFailed(scenario) {
      if (failures.length === 0) return
      const lines = failures.map(f => `  ✗ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`).join('\n')
      throw new Error(`场景「${scenario}」失败：\n${lines}`)
    },
  }
}

/** 本地时区的 HH:MM:SS，与新鲜度行印出的形状一致（断言与时区无关）。 */
export function clockTimeOf(at) {
  const d = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
