FROM node:22-alpine
WORKDIR /app
COPY package.json server.js db.js questions.js ai.js custom-questions*.json ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/quiz.db TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
