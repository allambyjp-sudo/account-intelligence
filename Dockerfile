# One image for both processes:
#   web:     docker run ... account-intelligence npm start
#   worker:  docker run ... account-intelligence npm run worker
#   migrate: docker run ... account-intelligence npm run db:migrate
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Build needs a session secret to be present, not a real one.
RUN SESSION_SECRET=build-time-placeholder-not-used-at-runtime-000 npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN useradd --create-home --uid 10001 app
COPY --from=build --chown=app:app /app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
