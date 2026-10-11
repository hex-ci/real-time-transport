import { buildApp } from './app.js'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'

async function main() {
  // 实时节拍的来源与优先级只有一处实现（`resolvePollIntervalSec`，在 buildApp 里调用）：
  // 设置页的选择 > 环境变量 > 这里的启动参数 > 默认 18s。故 index.ts 不再自己解析环境变量 ——
  // 它曾经各写一份，两边对「无效值」的判法还不一样。
  const app = await buildApp()
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
