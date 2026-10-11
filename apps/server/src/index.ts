import { buildApp } from './app.js'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'

async function main() {
  // TRANSIT_POLL_INTERVAL_SEC 之前只在 .env.example 里存在，buildApp() 根本没接：
  // index.ts 不传 options，app.ts 里恒为 undefined，实际轮询间隔永远是硬编码 18s。
  // 这里把环境变量接上，无效值回退默认 18s。
  const pollIntervalSec = Number(process.env.TRANSIT_POLL_INTERVAL_SEC)
  const app = await buildApp(
    Number.isFinite(pollIntervalSec) && pollIntervalSec > 0 ? { pollIntervalSec } : {},
  )
  try {
    await app.listen({ port, host })
    app.log.info(`Server listening at http://${host}:${port}`)
  }
  catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  const closeGracefully = async () => {
    try {
      if (app.websocketServer) {
        for (const client of app.websocketServer.clients) {
          client.terminate()
        }
      }
    }
    catch {
    }

    const forceExitTimer = setTimeout(() => {
      process.exit(0)
    }, 400)

    try {
      await app.close()
    }
    catch {
    }
    finally {
      clearTimeout(forceExitTimer)
      process.exit(0)
    }
  }

  process.once('SIGINT', closeGracefully)
  process.once('SIGTERM', closeGracefully)
}

main()
