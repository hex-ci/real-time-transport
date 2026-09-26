import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * F7「加到主屏」的安装面：PRD 承诺的每一句，都对着浏览器与实际收到的字节守住。
 *
 * PRD 的 F7 只有三句话：能加到手机主屏、点一下直达结论页、且**不加 service worker、不加推送**。
 * 前两句落在 manifest 与路由上，第三句是「不加什么」——只有把缺席本身钉住，它才不是一句口号。
 *
 * `installability.test.ts` 逐属性守住这个安装面的每个值（每个图标的不透明性、可遮罩安全圈、
 * head 的每个 meta）；本文件守的是**承诺本身**：字段与首页路由对得上（点一下真的落在结论页，
 * 而不是某个子页或一次重定向）、短名是主屏放得下的那个名字、声明与磁盘上的文件一对一、
 * 以及没有 worker 也没有推送的任何一半。两者刻意分工：值改坏了由前者报，承诺不再成立由这里报。
 *
 * 位于 `src/` 之外，理由同上：它验证包的安装表面（manifest、public/、index.html、vite.config.ts、
 * 路由表），这些都不是模块。
 */

const repoFile = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const manifestSource = readFileSync(repoFile('../public/manifest.webmanifest'), 'utf8')
const manifest = JSON.parse(manifestSource) as {
  name?: string
  short_name?: string
  start_url?: string
  display?: string
  theme_color?: string
  background_color?: string
  icons?: Array<{ src: string, sizes: string, type: string, purpose?: string }>
  [key: string]: unknown
}

const publicDir = repoFile('../public')
const sourceDir = repoFile('../src')
const indexHtml = readFileSync(repoFile('../index.html'), 'utf8')
const viteConfig = readFileSync(repoFile('../vite.config.ts'), 'utf8')
const routerSource = readFileSync(repoFile('../src/router/index.ts'), 'utf8')

/**
 * 只读 PNG 的 IHDR：签名之后第一个块就是它，宽高在其前 8 个字节。
 * 这里断言的是「声明与磁盘上的文件尺寸相符」，像素级的不透明性由 `installability.test.ts` 读。
 */
function pngSize(file: string): { width: number, height: number } {
  const bytes = readFileSync(file)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error(`${file} is not a PNG`)
  const type = bytes.toString('latin1', 12, 16)
  if (type !== 'IHDR') throw new Error(`${file}: the first chunk is ${type}, not IHDR`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** 应用源码里出现某个调用点的文件，按相对路径。 */
function sourceFilesMatching(pattern: RegExp): string[] {
  return readdirSync(sourceDir, { recursive: true })
    .filter(entry => /\.(?:ts|vue|js)$/.test(entry))
    .filter(entry => pattern.test(readFileSync(`${sourceDir}/${entry}`, 'utf8')))
}

describe('F7 · 点一下直达结论页', () => {
  it('start_url 指的就是应用自己的首页，不是子页也不是一次重定向', () => {
    // 从主屏图标进入时没有地址栏可以纠正一个错的 start_url。
    expect(manifest.start_url).toBe('/')

    // 首页 = 路由表里 '/' 那一条：它必须就是结论页本身，而不是把访客送到别处的一条规则。
    const homeRoute = routerSource.slice(routerSource.indexOf(`path: '/'`))
    expect(homeRoute.slice(0, 200)).toContain(`name: 'overview'`)
    expect(homeRoute.slice(0, 200)).toContain(`import('@/views/overview/index.vue')`)
    expect(homeRoute.slice(0, 200), 'the home route redirects instead of rendering the board')
      .not.toContain('redirect:')
  })
})

describe('F7 · 主屏标签与 manifest 的字段', () => {
  it('名称与短名都在，且短名是主屏放得下的那个名字', () => {
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    // 主屏图标下的标签在十来字之后被截断；声明的短名若更长，装上去看到的就是被切掉的名字。
    expect([...String(manifest.short_name)].length).toBeLessThanOrEqual(12)
  })

  it('display 是 standalone，主题色是一个真实的六位色值', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('图标声明齐了安装所需的尺寸与类型', () => {
    const sizes = (manifest.icons ?? []).map(icon => icon.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect((manifest.icons ?? []).every(icon => icon.type === 'image/png')).toBe(true)
    expect((manifest.icons ?? []).some(icon => (icon.purpose ?? '').includes('maskable'))).toBe(true)
  })
})

describe('F7 · 声明的每一个图标都在盘上，且尺寸与声明相符', () => {
  it('manifest 的条目与 public/ 里的文件一对一', () => {
    const icons = manifest.icons ?? []
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      const file = icon.src.replace(/^\//, '')
      expect(existsSync(`${publicDir}/${file}`), `${icon.src} is declared but not on disk`).toBe(true)
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(pngSize(`${publicDir}/${file}`), `${icon.src} does not match ${icon.sizes}`)
        .toEqual({ width, height })
    }
  })
})

describe('F7 · 不加 service worker、不加推送', () => {
  it('没有 worker 文件，也没有注册它的调用点', () => {
    const publicFiles = readdirSync(publicDir)
    expect(publicFiles.filter(file => /service-?worker|workbox|^sw\.[jt]s$/i.test(file))).toEqual([])
    expect(sourceFilesMatching(/navigator\.serviceWorker|serviceWorker\.register|registerSW/)).toEqual([])
    // 打包器插件也是加 worker 的一种方式：声明里没有它，配置里也不许有。
    expect(viteConfig).not.toMatch(/workbox|vite-plugin-pwa|serviceWorker/i)
    expect(Object.keys(manifest).filter(key => /service-?worker|workbox/i.test(key))).toEqual([])
  })

  it('没有推送的任何一半：没有订阅调用点，也没有推送键', () => {
    // 推送要三样东西：订阅、权限、以及声明里的一个推送服务。本应用按决定一样都没有。
    expect(sourceFilesMatching(/pushManager|PushManager|Notification\.requestPermission|showNotification/))
      .toEqual([])
    expect(Object.keys(manifest).filter(key => /push|gcm_sender_id/i.test(key))).toEqual([])
    expect(indexHtml).not.toMatch(/pushManager|PushManager|service-?worker|workbox/i)
  })
})
