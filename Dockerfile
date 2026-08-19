# Stage 1: Install dependencies and build
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm

# Copy workspace manifests first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/byos/package.json apps/byos/
COPY packages/common/package.json packages/common/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Stage 2: Runtime
FROM node:22-alpine
WORKDIR /app
RUN corepack enable pnpm

COPY --from=build /app .

EXPOSE 9585 9586
CMD ["node", "apps/byos/dist/index.js"]
