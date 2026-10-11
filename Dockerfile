# Render free tier: Docker runtime, Node 24 (node:sqlite is built in — no native deps).
FROM node:24-slim

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# SQLite file lives here. NOTE: on Render's free tier the filesystem is
# ephemeral — the database resets on redeploy/restart. Fine for trial.
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/trial.db

EXPOSE 3000
CMD ["node", "server.js"]
