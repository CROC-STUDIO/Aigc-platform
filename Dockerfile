FROM node:22.11.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ffmpeg \
     ca-certificates \
     fonts-dejavu-core \
     python3 \
     python3-pil \
  && npm install -g tai-ai \
  && mkdir -p /data/app /data/users /data/project-data \
  && chown -R node:node /data \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8000) + '/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
