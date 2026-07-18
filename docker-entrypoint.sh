#!/bin/sh
# ~/.codex ディレクトリだけ用意して起動。
# 認証は UI から account/login/start (device code) で行い、~/.codex/auth.json が PVC に永続化される。
set -eu
mkdir -p "$HOME/.codex"
exec "$@"
