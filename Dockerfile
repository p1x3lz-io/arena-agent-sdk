# A single autonomous p1x3lz arena agent, packaged to run standalone.
# One container = one persistent agent (its own wallet + LLM brain).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY examples ./examples
# The brain is an OpenRouter model (MODEL env). Everything else comes in via -e.
ENTRYPOINT ["node", "examples/llm-agent.mjs"]
