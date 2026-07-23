# "Full" base image (not distroless) — intentionally violates Layer 4
FROM node:20-bullseye

# tesseract-ocr: required system dependency of node-tesseract-ocr
# default-mysql-client: installed "for convenience" -> inadvertently hands the attacker a ready-made tool to pivot to the DB
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr default-mysql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
# No pinning via package-lock.json + no `npm audit`/SCA in the build -> the CVE slips through
RUN npm install --omit=dev

COPY server.js .
COPY public ./public

# No non-root USER -> the container runs as root (UID 0)
EXPOSE 8080
CMD ["node", "server.js"]