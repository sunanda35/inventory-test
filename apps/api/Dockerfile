FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps/api apps/api
COPY apps/web apps/web
COPY .prettierrc.json ./
RUN npm run build -w @inventory/api

FROM node:20-alpine

WORKDIR /app

COPY --from=build /app /app

EXPOSE 3001

CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && node apps/api/dist/server.js"]
