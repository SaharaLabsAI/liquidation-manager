# Runs the monitor from source with Node's built-in TypeScript type stripping (no build step).
# Build from this directory: docker build -t sahara-liquidity-monitor .
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# State (cursors, open alerts, pending Timelock operations, CCIP messages) must survive restarts: mount a volume.
RUN mkdir -p /app/state && chown node:node /app/state
VOLUME ["/app/state"]
USER node

EXPOSE 9464
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s CMD wget -qO- http://127.0.0.1:9464/healthz >/dev/null || exit 1

ENTRYPOINT ["node", "src/cli.ts"]
CMD ["run", "--config", "/app/config.yaml"]
