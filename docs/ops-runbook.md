# 部署运维手册

生产环境用 `docker-compose.prod.yml` 一键部署。与 dev 的 `docker-compose.yml`（仅 postgres）
相互独立：独立项目名 `real-time-transport-prod` + 容器名/卷名 `-prod` 后缀，可在同机共存。

## 服务拓扑

```
postgres (healthcheck)
   └─> migrate (一次性，跑完 Exited 0)
          └─> server (Fastify :3000，内部网络)
                 └─> web (nginx :80，反代 /api、/ws、/health → server:3000)
```

- `migrate` 以 `service_completed_successfully` 门控 `server`，确保库结构就绪后才起服务
- `server` 有 healthcheck（node fetch 探 `/health`），`web` 等其 healthy 才启动
- `web` 经 nginx 同源反代 REST 与 WS，前端无需配置后端地址，无 CORS
- 仅 `web` 暴露宿主机端口（`WEB_PORT`，默认 80）；postgres/server 仅在 compose 内部网络可达

## 环境变量

生产变量放 `.env.prod`，**不是**根 `.env`。根 `.env` 是 dev 的权威源（`DATABASE_URL`
指向宿主机 dev 数据库、`PORT` 是 dev 端口），与容器内网络不兼容。

```bash
cp .env.prod.example .env.prod
# 编辑 .env.prod：
#   - DATABASE_URL 的密码须与 POSTGRES_PASSWORD 一致
#   - 填 AMAP_MAPS_API_KEY（逆地理编码，仅服务端使用）
#   - CHELAILE_SIGN_SALT / CHELAILE_AES_KEY 留空即用代码内置默认值
#   - TRANSIT_SIMULATION 生产必须 false
```

`DATABASE_URL` 中的主机名是 compose 服务名 `postgres`（容器内 DNS），不是 localhost。

## 部署

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
# 期望：migrate=Exited(0)，postgres/server/web=Up (healthy)

curl http://localhost:${WEB_PORT:-80}/health
# {"status":"ok","timestamp":...,"simulation":false}
```

首次启动 migrate 会建表；重复执行幂等（已应用的文件打印 `skip`）。

## 升级

```bash
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
# migrate 自动执行新增迁移；server 在其成功后重建重启
```

升级前建议备份：

```bash
docker exec real-time-transport-prod-postgres \
  pg_dump -Fc -U transit transit > backup_$(date +%Y%m%d).dump
```

## 回滚

```bash
git checkout <上一个稳定 commit>
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
# 如需回滚迁移：
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate \
  pnpm --filter @real-time-transport/server exec tsx src/db/migrate.ts down
```

## 日志与诊断

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f server
docker compose --env-file .env.prod -f docker-compose.prod.yml logs migrate
docker exec real-time-transport-prod-postgres psql -U transit -c '\dt'
```

## 数据持久化

PostgreSQL 数据存于命名卷 `real-time-transport-prod-pgdata`。`down` 不删卷；
`down -v` 会**永久删除数据**，慎用。

## HTTPS

前端容器只监听 80。HTTPS 由宿主机 nginx 终止 TLS 后反代到 `127.0.0.1:${WEB_PORT}`，
需注意：反代时必须透传 `Upgrade` / `Connection` 头，否则 WebSocket 报站屏无法建连。

```nginx
location / {
    proxy_pass http://127.0.0.1;   # 换成你的 WEB_PORT
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

## 构建说明

后端镜像以 tsx 直跑 TS 源码（无编译产物）。源码内部一律以 `.js` 扩展名 import 实际的
`.ts` 文件（TS NodeNext 约定），只有 tsx 能解析；`packages/*` 也是 src-only 包，故镜像
内包含完整 workspace 源码。构建期 `pnpm` 经 corepack 激活，registry 指向
`registry.npmmirror.com`。
