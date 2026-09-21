FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
# The page shows this, linked to the source at that commit, so a visitor can read what is actually running.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT NODE_ENV=production HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "server.js"]
