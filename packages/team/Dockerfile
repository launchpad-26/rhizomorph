# syntax=docker/dockerfile:1
# prd-51 ruling 13 / ADR-0035 / #433. Built from the repo root:
#   docker build -f packages/team/Dockerfile -t rhizomorph-team .
# (packages/team/deploy/compose.yml's `build.context` does this for you.)
#
# packages/team/package.json deliberately carries no build script and no
# devDependencies of its own (#433's fence forbids adding one). This build
# therefore installs the WHOLE workspace at the repo root to get `tsx` onto
# PATH from packages/server's devDependency, and runs the team server straight
# from TypeScript source at runtime — see the plan on #433 for why bundling
# was rejected (it breaks packages/team/src/migrations/runner.ts's
# import.meta.url-derived MIGRATIONS_DIR default).
#
# Both stages MUST use the same base image tag. A build-stage/runtime-stage
# mismatch (e.g. slim vs alpine) fetches esbuild's native binary for the wrong
# libc and fails at runtime with no useful error at build time.

FROM node:22.22.2-bookworm-slim AS deps
WORKDIR /repo
# This build never runs Playwright; skip its ~300MB browser download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/app/package.json packages/app/package.json
COPY packages/team/package.json packages/team/package.json
RUN npm ci

FROM node:22.22.2-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/core/src packages/core/src
COPY packages/team/package.json packages/team/package.json
COPY packages/team/src packages/team/src
COPY packages/team/deploy packages/team/deploy
RUN mkdir -p /data/journal && chown -R node:node /data/journal /repo
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "packages/team/deploy/healthcheck.mjs"]
CMD ["node_modules/.bin/tsx", "packages/team/deploy/serve.ts"]
