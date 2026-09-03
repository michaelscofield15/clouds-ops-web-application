FROM node:20-bookworm-slim

WORKDIR /app

COPY cloudops-demo-app ./cloudops-demo-app
COPY platform-service ./platform-service

WORKDIR /app/cloudops-demo-app
RUN npm ci --omit=dev

WORKDIR /app/platform-service
RUN npm ci --omit=dev

EXPOSE 4000
EXPOSE 3000

WORKDIR /app

CMD ["sh", "-c", "PORT=3000 node cloudops-demo-app/src/server.js & PORT=4000 node platform-service/src/server.js & wait"]
