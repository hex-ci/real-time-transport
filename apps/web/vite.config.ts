import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { join } from 'node:path'

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
      vue(),
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
