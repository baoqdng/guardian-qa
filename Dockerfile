# Sử dụng image chính thức đã cài sẵn Chromium, Firefox, WebKit & Node.js
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Copy file quản lý package trước để tận dụng Docker layer cache
COPY package*.json ./
RUN npm ci

# Copy toàn bộ mã nguồn Agent, Healer, Quality Gate và Tests
COPY . .

# Biến môi trường mặc định (sẽ truyền GEMINI_API_KEY lúc chạy container)
ENV CI=true

# Mặc định chạy bộ đánh giá AI Quality Gate 15 kịch bản
CMD ["npx", "tsx", "eval_suite.ts"]