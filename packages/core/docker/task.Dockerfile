# The image a container lease runs tasks in. Build it yourself:
#
#   docker build -t ordewell-task - < task.Dockerfile
#
# Ordewell publishes no image holding Claude Code: Anthropic's terms say
# preinstalling or running it in a product or service needs its Commercial
# Terms and an unmodified binary (ADR-0059 L5). Add your project's toolchain
# below, leave out a runner you do not use, and rebuild when you want a newer one.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex

# For OpenCode tasks, add its MIT-licensed package as well:
# RUN npm install -g @opencode/cli

# A named volume takes its owner from the folder it mounts over, and a lease
# runs as uid 1000, which is the `node` user here.
RUN mkdir -p /task /mirror /login \
 && chown -R node:node /task /mirror /login

USER node
