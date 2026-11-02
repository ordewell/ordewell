# The image a container lease runs tasks in. Build it yourself:
#
#   docker build -t ordewell-task - < task.Dockerfile
#
# Ordewell publishes no image holding Claude Code: Anthropic's terms say
# preinstalling or running it in a product or service needs its Commercial
# Terms and an unmodified binary (ADR-0059 L5). Add your project's toolchain
# below, and rebuild when you want a newer Claude Code.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# A named volume takes its owner from the folder it mounts over, and a lease
# runs as uid 1000, which is the `node` user here.
RUN mkdir -p /task /mirror /login \
 && chown -R node:node /task /mirror /login

USER node
