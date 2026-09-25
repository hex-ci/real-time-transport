import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * F7's install contract, held against the bytes the browser actually receives.
 *
 * Installability is a set of files and values that no other layer in this repo
 * reads: a manifest the bundler merely copies, head tags nothing imports, and four
 * PNGs no module references. Nothing else in the test suite or in the type checker
 * can notice when one of them goes missing, so the contract is pinned here — and
 * pinned against decoded pixels and parsed JSON rather than against text, because
 * a `toContain` on a file passes just as happily when the value it names has been
 * changed to the wrong one (`default` instead of `black-translucent`, a 1×1
 * placeholder instead of 180×180, an RGBA icon instead of an opaque one).
 *
 * Test names say which half they are: `(behavioural: …)` means the assertion is
 * made against parsed data or decoded pixels — the file is actually opened and
 * understood — while `(structural: …)` means it is a presence check on a tag or a
 * config line, which is all that can be said about an attribute no runtime reads.
 *
 * This file lives outside `src/` on purpose: it verifies the install surface of the
 * package (index.html, public/, vite.config.ts), none of which is a module.
 */

/* ---------------------------------------------------------------- PNG reader */

/**
 * The smallest PNG reader that can answer what installability asks: is this really
 * a PNG, how big is it, does it carry transparency, and which pixels are not the
 * backdrop? `zlib` is the only dependency — the format is a signature, a chunk
 * list, and per-row filters over one inflated stream.
 *
 * 8-bit colour types 0/2/3/4/6, non-interlaced, are accepted; anything else throws
 * with the file name so a regenerated icon in an unexpected encoding fails loudly
 * rather than being read as an empty image.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Channels per pixel, by PNG colour type. 4 and 6 are the ones with an alpha channel. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

type Rgb = readonly [number, number, number]

interface DecodedPng {
  name: string
  width: number
  height: number
  /** IHDR colour type: 2 is truecolour with no channel to be transparent in. */
  colourType: number
  /** True for colour types 4 and 6 — the alpha-channel case iOS composites onto black. */
  hasAlphaChannel: boolean
  /** True when a `tRNS` chunk also marks pixels transparent (colour types 0/2/3). */
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

/** PNG's per-scanline predictors: None, Sub, Up, Average, Paeth. */
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

/* -------------------------------------------------------------- fixtures */

const publicDir = fileURLToPath(new URL('../public', import.meta.url))

const publicFile = (name: string) => join(publicDir, name)

const readPublic = (name: string) => readFileSync(publicFile(name))

const loadPng = (name: string) => decodePng(name, readPublic(name))

/** A 6-digit hex colour, as the manifest spells colours. */
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

/** `index.html` sits at the package root, beside `public/` — not inside it. */
const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

/** The `name`/`rel`-keyed attributes of the head's `meta` and `link` tags, as data. */
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

/** How far a pixel is from the backdrop, summed over its channels. */
const distanceFrom = (pixel: Rgb, backdrop: Rgb) =>
  Math.abs(pixel[0] - backdrop[0]) + Math.abs(pixel[1] - backdrop[1]) + Math.abs(pixel[2] - backdrop[2])

/**
 * Thresholds for "this pixel is part of the artwork, not the backdrop".
 *
 * ImageMagick writes lossless PNGs of a flat two-colour drawing, so the backdrop is
 * exact and every anti-aliased edge pixel sits far from it: 24 ignores nothing real,
 * 300 counts only pixels that are essentially the glyph's own colour.
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

/* ----------------------------------------------------------------- tests */

describe('F7 · the manifest an installer reads', () => {
  it('launches standalone, with no browser chrome around the board (behavioural: parsed manifest)', () => {
    // `standalone` is not cosmetic: it is the only mode in which the viewport
    // reaches under the status bar and the home indicator, which is what the safe
    // -area insets on the header and <main> are clearing space for.
    expect(manifest.display).toBe('standalone')
  })

  it('starts at the board, not at a sub-page (behavioural: parsed manifest)', () => {
    // From a home-screen icon there is no address bar to correct a wrong start_url.
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
    // `prefer_related_applications` disqualifies a web app from being installable.
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
    // A vendor name or a marketing register would make the home-screen label a claim
    // about a source or a product rather than the name of the thing being opened.
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
    // Two separate ways a PNG can be transparent: an alpha channel, which iOS paints
    // onto black before masking, and a tRNS chunk on a channel-less type.
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
    // The launcher, the splash screen and the mask's padding all sit against the
    // manifest's declared colours; an icon drawn on a slightly different backdrop
    // shows as a visible rectangle the moment the platform rounds its corners.
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
    // The failure this catches is silent: a rasteriser that drops the artwork still
    // writes a valid, correctly sized, fully opaque PNG.
    for (const file of [appleTouchIcon, ...manifestIconFiles]) {
      const icon = loadPng(file)
      const { artwork, stroke, total } = pixelStats(icon, BACKGROUND)
      expect(artwork / total, `${file} has no artwork`).toBeGreaterThan(0.01)
      expect(stroke / total, `${file} has no glyph-coloured pixels`).toBeGreaterThan(0.005)
    }
  })

  it('keeps the maskable artwork inside the 80% safe circle, and pads instead of copying (behavioural: decoded pixels)', () => {
    // A maskable icon can be cropped to a circle, a squircle or a teardrop, so its
    // artwork has to survive a crop to the inner 80% diameter. The plain icon draws
    // to a wider margin than that, which is exactly why the maskable one is a padded
    // render rather than a copy — and why a copy would fail the comparison below.
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
    // The href is what iOS fetches; the file it names is what the assertions above
    // hold to 180x180 and opaque, so the two must be the same path.
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
    // `default` and `black` reserve an opaque strip at the top: the page then starts
    // below the status bar, `safe-area-inset-top` stays 0 and the header's clearance
    // does nothing. Only `black-translucent` lets the page paint underneath.
    expect(metaContent('apple-mobile-web-app-status-bar-style')).toBe('black-translucent')
    expect(metaContent('theme-color')).toBe(manifest.theme_color)
  })
})

describe('F7 · no service worker', () => {
  it('ships no worker file and no PWA plugin (structural: file and config absence)', () => {
    // Installability does not require a worker, and this app has none by decision:
    // a second cache to invalidate on every deploy, for nothing. These checks are the
    // ones that can only be structural — the absence of a thing, in files no runtime
    // reads — so they are stated as such rather than dressed up as behaviour.
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
