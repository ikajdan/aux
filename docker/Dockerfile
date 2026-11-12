# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM node:24-trixie-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --no-audit --no-fund

COPY . .

RUN npm run build

FROM debian:trixie-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 python3-venv ca-certificates curl latexmk texlive-latex-extra texlive-science texlive-xetex texlive-binaries && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --uid 10001 --create-home aux

WORKDIR /app

COPY server/requirements.txt ./server/requirements.txt
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r server/requirements.txt

COPY --from=build /app/dist ./dist
COPY server/ ./server/

USER 10001:10001

ENV HOST=0.0.0.0 PORT=8080 PYTHONDONTWRITEBYTECODE=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:8080/health"]

CMD ["/opt/venv/bin/python", "-m", "server.server"]
