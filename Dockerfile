FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./

RUN mkdir -p /app/data

EXPOSE 8002

CMD ["node", "server.js"]
