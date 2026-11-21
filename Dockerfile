# Official Playwright image with pre-installed Chromium, Firefox, WebKit & Node.js
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

# Copy package management files first to leverage Docker layer cache
COPY e2e-tests/package*.json ./
RUN npm ci

# Copy full test source code from e2e-tests
COPY e2e-tests/ .

# Default environment variables (GEMINI_API_KEY passed at runtime)
ENV CI=true

# Default command: run the 15-scenario AI Quality Gate evaluation suite
CMD ["npx", "tsx", "eval_suite.ts"]
