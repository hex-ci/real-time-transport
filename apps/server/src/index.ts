import { buildApp } from './app.js'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'

async function main() {
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
