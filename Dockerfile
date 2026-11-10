# 小书童网页版生产镜像：单端口提供静态页面 + /api，内部按账号 fork 租户进程。
# 构建：docker build -t xiaoshutong-web .
# 运行：docker run --env-file .env -v xst-data:/data -v xst-tenants:/tenants -p 127.0.0.1:8787:8787 xiaoshutong-web
FROM node:22-bookworm-slim

# better-sqlite3 需要本地编译工具链；其它原生依赖由平台专属 optional 包提供预编译二进制
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

COPY package.json pnpm-lock.yaml ./
# --ignore-scripts 跳过 Electron 二进制下载，随后只重建服务端需要的原生模块
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild better-sqlite3

COPY . .
# 构建期冒烟：原生模块可用 + 服务端入口语法正确，避免镜像跑起来才发现缺依赖
RUN node --input-type=commonjs -e "require('better-sqlite3'); console.log('[docker] better-sqlite3 OK')" \
    && node --check server/index.mjs \
    && node --check server/tenant-server.mjs \
    && node --check server/electron-shim.mjs
RUN pnpm exec vite build --config vite.web.config.ts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_ROOT=/data \
    XST_TENANT_ROOT_BASE=/tenants \
    STATIC_ROOT=/app/dist-web

VOLUME ["/data", "/tenants"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
