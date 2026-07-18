FROM node:22-slim

# ripgrep は codex CLI が内部で使う
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# codex CLI をグローバルに導入(プラットフォーム別の native ラッパーが optionalDeps 経由で入る)
RUN npm install -g --omit=dev @openai/codex@0.144.3 \
 && npm cache clean --force

# 非rootユーザ (Debian slim には node ユーザが最初から居るが uid が不定なので固定する)
RUN groupadd -r -g 10001 kadai && useradd -r -u 10001 -g 10001 -m -d /home/kadai kadai

WORKDIR /app
COPY --chown=kadai:kadai package.json server.mjs codex-client.mjs extract.mjs index.html ./
COPY --chown=kadai:kadai docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER kadai
ENV HOME=/home/kadai \
    PORT=8080 \
    DATA_DIR=/data \
    NODE_ENV=production

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
