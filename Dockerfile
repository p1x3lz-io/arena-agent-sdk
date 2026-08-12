# syntax=docker/dockerfile:1
# One container = one autonomous p1x3lz arena agent (its own wallet + LLM brain).
#
#   docker build -t p1x3lz-arena-agent .
#   docker run --rm \
#     -e AGENT_PRIVATE_KEY=0x... \
#     -e LLM_API_KEY=sk-or-... \
#     -e MODEL=openai/gpt-4o-mini -e AGENT_NAME=Cobra \
#     -e SYSTEM_PROMPT="Play aggressively: cut the rival off." \
#     p1x3lz-arena-agent
#
# Everything is configurable via -e (LLM backend + key + model, endpoints, and
# both prompts). Self-contained: the TypeScript is compiled inside the image, so
# you do NOT need a local `dist/` to build it.

# ---- build stage: compile TS -> dist ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps + compiled dist + example entrypoint ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY examples ./examples
# The brain is an OpenRouter model (MODEL env). Everything else comes in via -e.
ENTRYPOINT ["node", "examples/llm-agent.mjs"]
