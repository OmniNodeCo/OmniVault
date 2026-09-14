# syntax=docker/dockerfile:1
# OmniVault — zero-dependency Node server + static PWA frontend.
FROM node:26-alpine

ENV NODE_ENV=production \
    OMNIVAULT_DATA_DIR=/data \
    PORT=3000

WORKDIR /app

# Zero npm dependencies — no npm install step, tiny attack surface.
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/server.js"]
