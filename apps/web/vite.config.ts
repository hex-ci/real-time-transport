import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { join } from 'node:path'

/**
 * `@vitejs/plugin-vue`, compiling for the CLIENT.
 *
 * Vitest transforms a node test's imports through Vite's SSR pipeline, and the vue
 * plugin follows it: an SFC compiled for SSR exports `ssrRender` and no `render`, so
 * a component a test imports cannot be mounted — which is why this package's tests
 * only ever read a `.vue` file as text. This wrapper flips that ONE flag and leaves
 * everything else exactly as Vitest set it up (module resolution, `import.meta.url`,
 * the asset pipeline), because the source-reading tests in `src/__tests__` depend on
 * all of it. With it, `chain-page-wiring.test.ts` can mount the chain page through
 * `chain-page-harness.ts` and hold its wiring by behaviour.
 */
function vueCompiledForClient(): Plugin {
  const plugin = vue()
  /** The plugin's own transform, however Vite 8 wraps it (plain or object hook). */
  type VueTransform = (this: unknown, code: string, id: string, options?: { ssr?: boolean }) => unknown
  const inner = plugin.transform as VueTransform | { handler: VueTransform }
  return {
    ...plugin,
    name: 'vite-plugin-vue-client-compiled',
    transform(code, id, options) {
      const handler = typeof inner === 'function' ? inner : inner.handler
      return handler.call(this, code, id, { ...(options ?? {}), ssr: false }) as never
    },
  } as Plugin
}

export default defineConfig(({ mode }) => {
  const rootDir = join(import.meta.dirname, '../..')
  const rootEnv = loadEnv(mode, rootDir, '')
  const webEnv = loadEnv(mode, process.cwd(), '')
  const env = { ...rootEnv, ...webEnv }

  const host = env.VITE_HOST === 'true' ? true : (env.VITE_HOST || '127.0.0.1')
  const port = Number(env.VITE_PORT ?? 5173)
  const serverPort = Number(env.VITE_SERVER_PORT ?? env.PORT ?? 3000)
  const backend = `http://localhost:${serverPort}`

  return {
    envDir: rootDir,
    plugins: [
      vueCompiledForClient(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host,
      port,
      proxy: {
        '/api': backend,
        '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
      },
    },
  }
})
