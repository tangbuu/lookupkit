# syntax=docker/dockerfile:1

# --- build stage ------------------------------------------------------------
# Compiles TypeScript and installs production dependencies only. onnxruntime-node
# and playwright both ship prebuilt binaries, so this stage must run on the same
# platform as the runtime stage.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Playwright's postinstall would download a browser we are about to throw away;
# the runtime image already ships one.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Second, separate install so node_modules carries no dev dependencies forward.
RUN npm ci --omit=dev

# --- runtime stage ----------------------------------------------------------
# The official Playwright image carries Chromium, Firefox AND WebKit plus the
# several hundred shared libraries they need (fonts, GTK, NSS, libasound...).
# Verified in the image rather than assumed: /ms-playwright holds webkit-2359
# and firefox-1543 alongside chromium-1243, which is exactly what this project
# needs, since it defaults to WebKit (see src/fetch/browser.ts). Installing
# those libraries onto a plain slim base by hand is the usual source of "works
# locally, blank pages in Docker".
# The tag MUST match the playwright version in package.json — the npm package
# looks for a browser build keyed to its own version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE LICENSE-APACHE-2.0.txt ./
# The tokenizer is small and stays in git; the ~130MB int8 model does not
# (see scripts/fetch-model.mjs — GitHub hard-rejects any file over 100MB, so
# it was removed from git history entirely). `models/` in the build context
# still has the file today (present on disk locally, just gitignored), so
# this COPY works right now unchanged; fetch-model.mjs's job is verifying
# the checksum during the build either way, and actually downloading it in
# any future build context (fresh clone, CI) where the file is genuinely
# absent. This still bakes the model into the IMAGE, not just downloads it
# at container boot — a container that fetches its model on every start
# fails in exactly the environments where you most want it to just work;
# this is a one-time cost at BUILD time.
COPY scripts/fetch-model.mjs ./scripts/fetch-model.mjs
COPY models ./models
RUN node scripts/fetch-model.mjs

# The Playwright image provides this unprivileged user, and its browsers are
# installed where the user can reach them.
USER pwuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
