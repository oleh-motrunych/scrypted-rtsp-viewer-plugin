FROM node:22-bookworm-slim AS build
WORKDIR /plugin
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build

FROM build AS test
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN npm test

FROM node:22-bookworm-slim AS deploy
WORKDIR /plugin
COPY --from=build /plugin/dist ./dist
COPY --from=build /plugin/package.json /plugin/LICENSE /plugin/THIRD_PARTY_NOTICES.txt ./
COPY --from=build /plugin/scripts ./scripts
COPY --from=build /plugin/node_modules/readline-sync ./node_modules/readline-sync
ENTRYPOINT ["/bin/sh", "/plugin/scripts/docker-entrypoint.sh"]
CMD ["help"]
