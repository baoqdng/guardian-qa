FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV CI=true

CMD ["npx", "tsx", "eval_suite.ts"]