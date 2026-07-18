# startix_issue_box

「課題を1000個挙げる」イベント用のホワイトボード写真集計サービス。
写真をブラウザに投げると、Codex(`codex app-server`、ChatGPT ログイン認証)が課題を文字起こしし、カテゴリ分けして件数を集計する。

k8s-homelab の1マイクロサービスとして稼働(LAN 限定、`<nodeIP>:6220`)。

## 構成

- `server.mjs` — HTTP サーバー・アップロード・処理キュー・永続化
- `codex-client.mjs` — `codex app-server`(stdio JSONL の JSON-RPC)クライアント
- `extract.mjs` — 画像1枚 → `turn/start`(`localImage` + `outputSchema`)で課題を JSON 抽出
- `index.html` — UI(モバイル対応、Notion 風の課題テーブル+フィルタ)
- `Dockerfile` — Node 22 + `@openai/codex` グローバル導入 + 非rootユーザ
- `docker-entrypoint.sh` — PVC 上に `~/.codex/auth.json` が無ければ Secret から seed
- `k8s/` — Deployment / Service(LB:6220) / PVC(data 5Gi + codex-home 200Mi) / SealedSecret
- `.github/workflows/build.yml` — push で ghcr にビルド→`k8s/kustomization.yaml` に sha 書き戻し

## デプロイ

k8s-homelab の `apps/startix-issue-box.yaml` からポイントされる。`main` に push すると:
1. GitHub Actions が `ghcr.io/onethingtsukuba/startix-issue-box:<sha>` をビルド
2. CI が `k8s/kustomization.yaml` の image tag を新 sha に書き戻し
3. ArgoCD が自動同期し、Deployment が新 image に切り替わる

## codex 認証

`~/.codex/auth.json`(ChatGPT OAuth の access/refresh token)を SealedSecret にして `k8s/sealedsecret-codex-auth.yaml` に含める。

- **初回**: `docker-entrypoint.sh` が PVC(`startix-issue-box-codex-home`)を確認し、`auth.json` が無ければ Secret マウント (`/run/codex-init/auth.json`) からコピーする。
- **以降**: codex が自動でトークンを refresh するたび PVC 内の `auth.json` が上書きされるため、access token 失効の心配は無い。refresh token が失効するまで(通常数十日〜数か月)動作する。
- **再ログインが必要になった場合**: ローカルで `codex login` → 新しい `~/.codex/auth.json` を kubeseal し直して push → PVC 内容を一度削除して再 seed。

再 seal 手順:
```sh
scp ~/.codex/auth.json ubuntu-server-3:/tmp/sib-auth.json
ssh ubuntu-server-3 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && \
  kubectl create secret generic startix-issue-box-codex-auth --namespace=startix-issue-box \
    --from-file=auth.json=/tmp/sib-auth.json --dry-run=client -o yaml \
  | kubeseal --controller-namespace=kube-system --controller-name=sealed-secrets-controller -o yaml && \
  rm /tmp/sib-auth.json' > k8s/sealedsecret-codex-auth.yaml
# PVC seed し直し
ssh ubuntu-server-3 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && \
  kubectl -n startix-issue-box exec deploy/startix-issue-box -- rm -f /home/kadai/.codex/auth.json && \
  kubectl -n startix-issue-box rollout restart deploy/startix-issue-box'
```

## ローカル開発

```sh
DATA_DIR=$PWD PORT=5832 node server.mjs   # http://localhost:5832
```
