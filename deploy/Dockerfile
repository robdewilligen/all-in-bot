FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# The build only needs tsc; no dependency needs its install script (package.json denies esbuild's).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# dist/db/migrations.js reads the migrations from ../../drizzle, which is /app/drizzle.
COPY drizzle ./drizzle
USER node
# Migrations first (SPEC 10); exec makes the bot the process that receives SIGTERM.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
