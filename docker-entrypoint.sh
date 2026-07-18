#!/bin/sh
# codex 認証ファイルを PVC 上に配置する。
# - 初回(PVC空): Secret から /run/codex-init/auth.json をコピー
# - 2回目以降: PVCに残った auth.json を使う(トークンの refresh 書き戻しがそのまま生きる)
set -eu
mkdir -p "$HOME/.codex"
if [ ! -f "$HOME/.codex/auth.json" ]; then
  if [ -f /run/codex-init/auth.json ]; then
    cp /run/codex-init/auth.json "$HOME/.codex/auth.json"
    chmod 600 "$HOME/.codex/auth.json"
    echo "seeded ~/.codex/auth.json from /run/codex-init"
  else
    echo "ERROR: no auth.json in PVC and no /run/codex-init/auth.json to seed from" >&2
    exit 1
  fi
fi
exec "$@"
