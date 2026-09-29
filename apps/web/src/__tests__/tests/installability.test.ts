import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * F7 的安装契约，对着浏览器实际收到的字节守住。
 *
 * 可安装性是一组本仓库其他层都不读的文件与值：打包器只负责复制的 manifest、没人 import 的 head 标签、
 * 四个没有模块引用的 PNG。测试套件与类型检查器都无法察觉其中任何一个的缺失，故契约在此钉住——且对着
 * 解码像素与解析后的 JSON 而非文本，因为对文件的 `toContain` 在它所指名的值被改成错值时同样愉快地通过。
 *
 * 测试名已说明它属于哪一半：`(behavioural: …)` 表示断言针对解析数据或解码像素——文件确实被打开并理解——
 * 而 `(structural: …)` 表示它是对标签或配置行的存在性检查，这是对一个没有运行时会读取的属性所能说的全部。
 *
 * 本文件刻意位于 `src/` 之外：它验证包的安装表面（index.html、public/、vite.config.ts），这些都不是模块。
 */

/* ---------------------------------------------------------------- PNG reader */

/**
 * 能回答可安装性所需的最小 PNG 读取器：这真是 PNG 吗、多大、是否携带透明、哪些像素不是背景？
 * `zlib` 是唯一依赖——该格式即一个签名、一个块列表，以及一条解压流上的逐行滤波器。
 *
 * 接受 8 位颜色类型 0/2/3/4/6、非隔行；其他一律带文件名抛出，使以意外编码重新生成的图标大声失败，
 * 而非被读成空图像。
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** 每像素通道数，按 PNG 颜色类型。4 与 6 是带 alpha 通道的那些。 */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

type Rgb = readonly [number, number, number]

interface DecodedPng {
  name: string
  width: number
  height: number
  /** IHDR 颜色类型：2 是真彩色，没有可作透明的通道。 */
  colourType: number
  /** 颜色类型 4 与 6 时为真——即 iOS 会合成到黑色上的 alpha 通道情形。 */
  hasAlphaChannel: boolean
  /** `tRNS` 块也把像素标为透明（颜色类型 0/2/3）时为真。 */
  hasTransparency: boolean
  pixel(x: number, y: number): Rgb
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** PNG 的逐扫描线预测器：None、Sub、Up、Average、Paeth。 */
function predictorOf(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) return left
  if (filter === 2) return up
  if (filter === 3) return (left + up) >> 1
  if (filter === 4) return paeth(left, up, upLeft)
  return 0
}

function decodePng(name: string, bytes: Buffer): DecodedPng {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${name} is not a PNG (bad signature)`)
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colourType = 0
  let interlace = 0
  let palette: Rgb[] = []
  let trns: Buffer | null = null
  const idat: Buffer[] = []

  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8] ?? 0
      colourType = body[9] ?? 0
      interlace = body[12] ?? 0
    }
    else if (type === 'PLTE') {
      palette = Array.from({ length: Math.floor(body.length / 3) }, (_, index) =>
        [body[index * 3] ?? 0, body[index * 3 + 1] ?? 0, body[index * 3 + 2] ?? 0] as Rgb)
    }
    else if (type === 'tRNS') {
      trns = body
    }
    else if (type === 'IDAT') {
      idat.push(body)
    }
    offset += 12 + length
  }

  const channels = CHANNELS[colourType]
  if (channels === undefined) throw new Error(`${name}: unsupported colour type ${colourType}`)
  if (bitDepth !== 8) throw new Error(`${name}: unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error(`${name}: interlaced PNG is not supported`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const flat = Buffer.alloc(height * stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++] ?? 0
    const row = raw.subarray(cursor, cursor + stride)
    cursor += stride
    const out = flat.subarray(y * stride, (y + 1) * stride)
    const prior = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const raw0 = row[i] ?? 0
      const left = i >= channels ? (out[i - channels] ?? 0) : 0
      const up = prior[i] ?? 0
      const upLeft = i >= channels ? (prior[i - channels] ?? 0) : 0
      const predictor = predictorOf(filter, left, up, upLeft)
      out[i] = (raw0 + predictor) & 0xff
    }
  }

  const pixel = (x: number, y: number): Rgb => {
    const at = y * stride + x * channels
    const one = flat[at] ?? 0
    if (colourType === 2 || colourType === 6) {
      return [one, flat[at + 1] ?? 0, flat[at + 2] ?? 0]
    }
    if (colourType === 0 || colourType === 4) return [one, one, one]
    return palette[one] ?? [0, 0, 0]
  }

  return {
    name,
    width,
    height,
    colourType,
    hasAlphaChannel: colourType === 4 || colourType === 6,
    hasTransparency: colourType === 4 || colourType === 6 || trns !== null,
    pixel,
  }
}

/* -------------------------------------------------------------- 夹具 */

const publicDir = fileURLToPath(new URL('../public', import.meta.url))

const publicFile = (name: string) => join(publicDir, name)

const readPublic = (name: string) => readFileSync(publicFile(name))

const loadPng = (name: string) => decodePng(name, readPublic(name))

/** 6 位十六进制颜色，即 manifest 拼写颜色的方式。 */
function rgbOf(hex: unknown, key: string): Rgb {
  const match = typeof hex === 'string' ? /^#([0-9a-f]{6})$/i.exec(hex) : null
  if (!match) throw new Error(`${key} must be a 6-digit hex colour, got ${JSON.stringify(hex)}`)
  const digits = match[1] ?? '000000'
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ]
}

const manifest = JSON.parse(readPublic('manifest.webmanifest').toString('utf8')) as {
  name?: string
  short_name?: string
  start_url?: string
  display?: string
  background_color?: string
  theme_color?: string
  icons?: Array<{ src: string, sizes: string, type: string, purpose?: string }>
  [key: string]: unknown
}

const iconEntries = manifest.icons ?? []
const BACKGROUND = rgbOf(manifest.background_color, 'background_color')

const appleTouchIcon = 'apple-touch-icon.png'
const manifestIconFiles = iconEntries.map(entry => entry.src.replace(/^\//, ''))

/** `index.html` 位于包根，在 `public/` 旁——不在其内。 */
const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

/** head 的 `meta` 与 `link` 标签按 `name`/`rel` 键的属性，作为数据。 */
function headTags(tag: 'meta' | 'link'): Array<Record<string, string>> {
  const head = indexHtml.slice(indexHtml.indexOf('<head'), indexHtml.indexOf('</head>'))
  const tags: Array<Record<string, string>> = []
  for (const tagMatch of head.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))) {
    const attributes: Record<string, string> = {}
    for (const attribute of (tagMatch[1] ?? '').matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      attributes[(attribute[1] ?? '').toLowerCase()] = attribute[2] ?? ''
    }
    tags.push(attributes)
  }
  return tags
}

const metas = headTags('meta')
const links = headTags('link')
const metaContent = (name: string) => metas.find(meta => meta.name === name)?.content
const linkFor = (rel: string) => links.find(link => link.rel === rel)

/** 一个像素离背景有多远，按其各通道求和。 */
const distanceFrom = (pixel: Rgb, backdrop: Rgb) =>
  Math.abs(pixel[0] - backdrop[0]) + Math.abs(pixel[1] - backdrop[1]) + Math.abs(pixel[2] - backdrop[2])

/**
 * 「该像素属于画面而非背景」的阈值。
 *
 * ImageMagick 写出平涂两色画的无损 PNG，故背景是精确的，每个抗锯齿边缘像素都远离它：24 不忽略任何
 * 真实像素，300 只计入基本是字形自身颜色的像素。
 */
const ARTWORK = 24
const STROKE = 300

function pixelStats(icon: DecodedPng, backdrop: Rgb) {
  let artwork = 0
  let stroke = 0
  let furthest = 0
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) {
      const distance = distanceFrom(icon.pixel(x, y), backdrop)
      if (distance > ARTWORK) {
        artwork++
        if (distance > STROKE) stroke++
        furthest = Math.max(furthest, Math.hypot(x + 0.5 - icon.width / 2, y + 0.5 - icon.height / 2))
      }
    }
  }
  return { artwork, stroke, furthest, total: icon.width * icon.height }
}

/* ----------------------------------------------------------------- 测试 */

describe('F7 · the manifest an installer reads', () => {
  it('launches standalone, with no browser chrome around the board (behavioural: parsed manifest)', () => {
    // `standalone` 不是装饰：它是视口能伸到状态栏与 home indicator 之下的唯一模式，
    // 而 header 与 <main> 的安全区内边距正是为此留空间。
    expect(manifest.display).toBe('standalone')
  })

  it('starts at the board, not at a sub-page (behavioural: parsed manifest)', () => {
    // 从主屏图标进入时没有地址栏可纠正错误的 start_url。
    expect(manifest.start_url).toBe('/')
  })

  it('declares the 192 and 512 icons Chrome requires, plus a maskable variant (behavioural: parsed manifest)', () => {
    const sizes = iconEntries.map(entry => entry.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(iconEntries.every(entry => entry.type === 'image/png')).toBe(true)
    expect(iconEntries.some(entry => (entry.purpose ?? 'any').split(/\s+/).includes('maskable'))).toBe(true)
  })

  it('does not defer to a native app store listing it has no app in (behavioural: parsed manifest)', () => {
    // `prefer_related_applications` 会让一个 web 应用失去可安装资格。
    expect(manifest).not.toHaveProperty('prefer_related_applications')
  })

  it('gives every declared icon a real file at exactly its declared size (behavioural: manifest → decoded PNG)', () => {
    expect(iconEntries.length).toBeGreaterThan(0)
    for (const entry of iconEntries) {
      const icon = loadPng(entry.src.replace(/^\//, ''))
      const [width, height] = entry.sizes.split('x').map(Number)
      expect([icon.width, icon.height], `${entry.src} does not match ${entry.sizes}`).toEqual([width, height])
    }
  })

  it('labels the home screen the same way in both installers (behavioural: parsed manifest + head)', () => {
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(metaContent('apple-mobile-web-app-title')).toBe(manifest.short_name)
    // 厂商名或营销语域会让主屏标签变成关于某个来源或产品的断言，而非所打开之物的名字。
    for (const label of [manifest.name, manifest.short_name, metaContent('apple-mobile-web-app-title')]) {
      expect(label ?? '').not.toMatch(/车来了|高德|极数本源|chelaile|apizero/i)
      expect(label ?? '').not.toMatch(/官方|免费|最好|最佳|\b(?:app|pro|lite|plus|beta)\b/i)
    }
  })
})

describe('F7 · the icon files themselves', () => {
  it('ships the apple-touch-icon opaque, with no alpha channel to composite onto black (behavioural: decoded IHDR)', () => {
    const icon = loadPng(appleTouchIcon)
    expect([icon.width, icon.height]).toEqual([180, 180])
    // PNG 可以透明的两种不同方式：alpha 通道（iOS 在遮罩前把它涂到黑上），
    // 以及无通道类型上的 tRNS 块。
    expect(icon.hasAlphaChannel, 'the icon has an alpha channel').toBe(false)
    expect(icon.hasTransparency, 'the icon has transparent pixels').toBe(false)
    expect(icon.colourType).toBe(2)
  })

  it('ships every manifest icon opaque as well (behavioural: decoded IHDR)', () => {
    for (const file of manifestIconFiles) {
      const icon = loadPng(file)
      expect(icon.hasAlphaChannel, `${file} has an alpha channel`).toBe(false)
      expect(icon.hasTransparency, `${file} has transparent pixels`).toBe(false)
    }
  })

  it('backs every icon with the manifest\'s own background colour, so a mask shows no seam (behavioural: decoded pixels)', () => {
    // 启动器、闪屏与遮罩的内边距都对着 manifest 声明的颜色；画在略不同背景上的图标
    // 会在平台圆角的那一刻显示为可见矩形。
    expect(rgbOf(manifest.theme_color, 'theme_color')).toEqual(BACKGROUND)
    const files = [appleTouchIcon, ...manifestIconFiles]
    for (const file of files) {
      const icon = loadPng(file)
      const corners: Rgb[] = [
        icon.pixel(0, 0),
        icon.pixel(icon.width - 1, 0),
        icon.pixel(0, icon.height - 1),
        icon.pixel(icon.width - 1, icon.height - 1),
      ]
      for (const corner of corners) {
        expect(corner, `${file} does not reach its own corners with the backdrop`).toEqual(BACKGROUND)
      }
    }
  })

  it('draws real artwork on every icon, so no blank render can ship (behavioural: decoded pixels)', () => {
    // 这里抓住的失败是静默的：丢掉画面的光栅化器仍会写出一个有效、尺寸正确、完全不透明的 PNG。
    for (const file of [appleTouchIcon, ...manifestIconFiles]) {
      const icon = loadPng(file)
      const { artwork, stroke, total } = pixelStats(icon, BACKGROUND)
      expect(artwork / total, `${file} has no artwork`).toBeGreaterThan(0.01)
      expect(stroke / total, `${file} has no glyph-coloured pixels`).toBeGreaterThan(0.005)
    }
  })

  it('keeps the maskable artwork inside the 80% safe circle, and pads instead of copying (behavioural: decoded pixels)', () => {
    // 可遮罩图标可被裁成圆形、超椭圆或泪滴形，故其画面必须经受裁到内侧 80% 直径。普通图标画到比那
    // 更宽的边距，这正是可遮罩那个是加过内边距的渲染而非复制品的原因——也是复制品会在下面的比较中
    // 失败的原因。
    const maskable = loadPng('icon-512-maskable.png')
    const plain = loadPng('icon-512.png')
    const maskableStats = pixelStats(maskable, BACKGROUND)
    const plainStats = pixelStats(plain, BACKGROUND)

    expect(maskableStats.furthest).toBeLessThanOrEqual(0.4 * maskable.width)
    expect(maskableStats.furthest).toBeLessThan(plainStats.furthest)
    expect(readPublic('icon-512-maskable.png').equals(readPublic('icon-512.png'))).toBe(false)
  })
})

describe('F7 · the head of index.html', () => {
  it('links the manifest and the apple-touch-icon to files that really are there (behavioural: href → real bytes)', () => {
    const manifestLink = linkFor('manifest')
    expect(manifestLink?.href).toBe('/manifest.webmanifest')
    expect(existsSync(publicFile('manifest.webmanifest')), 'the manifest the head links is missing').toBe(true)
    expect(() => JSON.parse(readPublic('manifest.webmanifest').toString('utf8'))).not.toThrow()

    const appleLink = linkFor('apple-touch-icon')
    expect(appleLink?.sizes).toBe('180x180')
    // href 是 iOS 去取的；它指名的文件正是上面断言要求 180x180 且不透明的那个，故两者必须是同一路径。
    expect(appleLink?.href).toBe(`/${appleTouchIcon}`)
  })

  it('keeps viewport-fit=cover, the half of the safe-area pair the metas need (structural: parsed attribute)', () => {
    const viewport = new Map(
      (metaContent('viewport') ?? '').split(',')
        .map(pair => pair.trim().split('='))
        .filter((parts): parts is [string, string] => parts.length === 2)
        .map(parts => [parts[0].trim(), parts[1].trim()] as const),
    )
    expect(viewport.get('width')).toBe('device-width')
    expect(viewport.get('viewport-fit')).toBe('cover')
  })

  it('opens an installed launch with no URL bar and no button bar (structural: the Apple metas\' exact values)', () => {
    expect(metaContent('apple-mobile-web-app-capable')).toBe('yes')
    // `default` 与 `black` 在顶部留出一条不透明带：页面随后从状态栏之下开始，
    // `safe-area-inset-top` 保持 0，header 的避让不起作用。只有 `black-translucent` 让页面画到下面。
    expect(metaContent('apple-mobile-web-app-status-bar-style')).toBe('black-translucent')
    expect(metaContent('theme-color')).toBe(manifest.theme_color)
  })
})

describe('F7 · no service worker', () => {
  it('ships no worker file and no PWA plugin (structural: file and config absence)', () => {
    // 可安装性不要求 worker，而本应用按决定没有：一个每次部署都要失效的缓存，换不来什么。
    // 这些检查是只能结构性的那些——某个东西的缺席，在没人读的文件里——故如此陈述，而不装扮成行为。
    const publicFiles = readdirSync(publicFile('.'))
    expect(publicFiles.filter(file => /service-?worker|workbox|^sw\.[jt]s$/i.test(file))).toEqual([])
    expect(Object.keys(manifest).filter(key => /service-?worker|workbox|^prefer_related_applications$/i.test(key))).toEqual([])
    expect(indexHtml).not.toMatch(/service-?worker|workbox/i)

    const viteConfig = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8')
    expect(viteConfig).not.toMatch(/workbox|vite-plugin-pwa|serviceWorker/i)
  })

  it('registers no worker from the app source either (structural: no call sites)', () => {
    const sourceDir = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(sourceDir, { recursive: true })
      .filter(entry => /\.(?:ts|vue|js)$/.test(entry))
    const registrations = files.filter((entry) => {
      const source = readFileSync(`${sourceDir}/${entry}`, 'utf8')
      return /navigator\.serviceWorker|serviceWorker\.register|registerSW/.test(source)
    })
    expect(registrations).toEqual([])
  })
})
