FROM node:22-alpine

WORKDIR /app

# serve.js is the entry point. lib/ holds the supporting modules.
# config.json is mounted at runtime via docker-compose volume.
COPY serve.js ./
COPY lib/ ./lib/
COPY index.js ./
COPY package.json ./

RUN mkdir -p /app/data && chown -R node:node /app

USER node

# Inside Docker, bind to 0.0.0.0 (container-internal; host exposure controlled by docker-compose ports)
ENV FFAI_BIND=0.0.0.0
ENV FFAI_PORT=8010

# Default port — override via FFAI_PORT env var (EXPOSE is documentation-only)
EXPOSE 8010

CMD ["node", "serve.js"]
