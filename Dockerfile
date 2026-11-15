# syntax = docker/dockerfile:1

FROM node:24-slim
WORKDIR /app

RUN npm install -g pnpm@11.9.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src/ src/
COPY slides/ slides/
COPY README.md ./
COPY docs/ docs/

ENV DATA_DIR=/data
ENV PORT=8080

CMD ["node", "src/server.ts"]
