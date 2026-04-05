FROM node:22-alpine

WORKDIR /app

COPY server.js ./
# providers.json is mounted at runtime via docker-compose volume

RUN mkdir -p /app/data && chown -R node:node /app

USER node

# Default port — override via PORT env var (EXPOSE is documentation-only)
EXPOSE 8002

CMD ["node", "server.js"]
