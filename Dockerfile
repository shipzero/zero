FROM node:22-alpine AS build

ARG VERSION=dev

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN sed -i "s/__VERSION__/${VERSION}/g" src/version.ts
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY --from=build /app/dist ./dist

EXPOSE 80 443 2020

CMD ["node", "dist/index.js"]
