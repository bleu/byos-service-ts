# Stage 1: Install dependencies and build
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm

# Copy workspace manifests first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/byos/package.json apps/byos/
COPY apps/baseline-subsolver/package.json apps/baseline-subsolver/
COPY apps/fynd-subsolver/package.json apps/fynd-subsolver/
COPY packages/common/package.json packages/common/
COPY packages/subsolver-core/package.json packages/subsolver-core/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Stage 2: Runtime — only dist + node_modules
FROM node:22-alpine
WORKDIR /app
RUN corepack enable pnpm

# Workspace root manifests (pnpm needs these for workspace resolution)
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
# pnpm's hoisted node_modules (includes .pnpm store)
COPY --from=build /app/node_modules node_modules/
# Built app + migrations + its local node_modules
COPY --from=build /app/apps/byos/dist apps/byos/dist/
COPY --from=build /app/apps/byos/drizzle apps/byos/drizzle/
COPY --from=build /app/apps/byos/package.json apps/byos/
COPY --from=build /app/apps/byos/node_modules apps/byos/node_modules/
# Built workspace dependency + its local node_modules
COPY --from=build /app/packages/common/dist packages/common/dist/
COPY --from=build /app/packages/common/package.json packages/common/
COPY --from=build /app/packages/common/node_modules packages/common/node_modules/
# Baseline subsolver executable and reusable provider package.
COPY --from=build /app/apps/baseline-subsolver/dist apps/baseline-subsolver/dist/
COPY --from=build /app/apps/baseline-subsolver/package.json apps/baseline-subsolver/
COPY --from=build /app/apps/baseline-subsolver/node_modules apps/baseline-subsolver/node_modules/
# Fynd subsolver executable.
COPY --from=build /app/apps/fynd-subsolver/dist apps/fynd-subsolver/dist/
COPY --from=build /app/apps/fynd-subsolver/package.json apps/fynd-subsolver/
COPY --from=build /app/apps/fynd-subsolver/node_modules apps/fynd-subsolver/node_modules/
COPY --from=build /app/packages/subsolver-core/dist packages/subsolver-core/dist/
COPY --from=build /app/packages/subsolver-core/package.json packages/subsolver-core/
COPY --from=build /app/packages/subsolver-core/node_modules packages/subsolver-core/node_modules/

EXPOSE 9585 9586
CMD ["node", "apps/byos/dist/index.js"]
