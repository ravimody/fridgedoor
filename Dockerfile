# syntax=docker/dockerfile:1
# Fridgedoor: web app, API and background worker in one image (linux/amd64 and linux/arm64).
FROM node:22.23.3-alpine3.24 AS build
WORKDIR /src
# Toolchain only for native modules without a prebuilt binary; it stays in this stage.
RUN apk add --no-cache python3 make g++ && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && pnpm --filter @fridgedoor/server deploy --prod --legacy /out/server

FROM node:22.23.3-alpine3.24
# su-exec drops root at start-up (see deploy/docker-entrypoint.sh).
RUN apk add --no-cache su-exec
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 WEB_DIST=/app/web/dist
WORKDIR /app/server
COPY --from=build /out/server ./
COPY --from=build /src/web/dist /app/web/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deploy/fridgedoor-cli.sh /usr/local/bin/fridgedoor
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/fridgedoor && mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
