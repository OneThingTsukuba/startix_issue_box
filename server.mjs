// 課題1000 集計サーバー: 画像アップロード → codex app-server で文字起こし・カテゴリ分け
import http from 'node:http';
import { readFile, writeFile, mkdir, unlink, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexClient } from './codex-client.mjs';
import { extractIssues } from './extract.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? ROOT;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CODEX_HOME = process.env.HOME ? path.join(process.env.HOME, '.codex') : path.join(ROOT, '.codex');
const PORT = Number(process.env.PORT ?? 3939);
const HOST = process.env.HOST ?? '0.0.0.0';

await mkdir(UPLOAD_DIR, { recursive: true });

// ---- 永続化 ----
let state = { photos: [] };
if (existsSync(DATA_FILE)) {
  try { state = JSON.parse(await readFile(DATA_FILE, 'utf8')); } catch {}
}
for (const p of state.photos) if (p.status === 'processing') p.status = 'pending';

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFile(DATA_FILE, JSON.stringify(state, null, 2)).catch(console.error), 200);
}

// ---- codex クライアント(認証状態に応じて起動/停止) ----
let codex = null;
async function ensureCodex() {
  if (codex) return codex;
  codex = new CodexClient();
  await codex.init();
  codex.onNotification((msg) => {
    if (msg.method === 'account/login/completed') {
      if (msg.params?.success) {
        auth = { status: 'authenticated', account: null };
        pumpQueue();
      } else {
        // 失敗 or キャンセル → 未認証状態に戻す
        auth = { status: 'unauthenticated' };
      }
    }
  });
  return codex;
}
async function killCodex() {
  if (codex) { codex.close(); codex = null; }
}

// ---- 認証状態 ----
// status: 'unknown' | 'unauthenticated' | 'pending' | 'authenticated'
let auth = { status: 'unknown' };

async function refreshAuthState() {
  try {
    const c = await ensureCodex();
    const r = await c.request('account/read', { refreshToken: false });
    if (r?.account) {
      auth = { status: 'authenticated', account: { email: r.account.email ?? null, planType: r.account.planType ?? null, type: r.account.type } };
    } else if (r?.requiresOpenaiAuth) {
      // pending 中は上書きしない
      if (auth.status !== 'pending') auth = { status: 'unauthenticated' };
    }
  } catch (e) {
    auth = { status: 'unauthenticated', error: String(e.message ?? e) };
  }
}
await refreshAuthState();

// ---- codex 処理キュー(直列)。未認証時は待機 ----
let queueRunning = false;
async function pumpQueue() {
  if (queueRunning || auth.status !== 'authenticated') return;
  queueRunning = true;
  try {
    const c = await ensureCodex();
    for (;;) {
      const photo = state.photos.find((p) => p.status === 'pending');
      if (!photo) break;
      if (auth.status !== 'authenticated') break;
      photo.status = 'processing';
      save();
      try {
        photo.issues = await extractIssues(c, path.join(UPLOAD_DIR, photo.file));
        photo.status = 'done';
        photo.error = null;
      } catch (e) {
        photo.status = 'error';
        photo.error = String(e.message ?? e);
        console.error(`extract failed for ${photo.file}:`, photo.error);
      }
      save();
    }
  } finally {
    queueRunning = false;
  }
}
pumpQueue();

// ---- HTTP ----
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) { reject(new Error('file too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.gif': 'image/gif' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(path.join(ROOT, 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    // ---- 認証 ----
    if (req.method === 'GET' && url.pathname === '/api/auth') {
      json(res, 200, auth);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      // device code フロー: verificationUrl と userCode を返す
      const c = await ensureCodex();
      const r = await c.request('account/login/start', { type: 'chatgptDeviceCode' });
      auth = {
        status: 'pending',
        loginId: r.loginId,
        verificationUrl: r.verificationUrl,
        userCode: r.userCode,
        startedAt: new Date().toISOString(),
      };
      json(res, 200, auth);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login/cancel') {
      if (auth.status === 'pending' && auth.loginId) {
        try { await (await ensureCodex()).request('account/login/cancel', { loginId: auth.loginId }); } catch {}
      }
      auth = { status: 'unauthenticated' };
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      try { if (codex) await codex.request('account/logout', {}); } catch {}
      await killCodex();
      // 保険で PVC 上の認証ファイルも消す
      try {
        for (const f of await readdir(CODEX_HOME).catch(() => [])) {
          if (f === 'auth.json' || f.startsWith('auth.') || f === 'tokens.json' || f === 'session.json') {
            await rm(path.join(CODEX_HOME, f), { force: true });
          }
        }
      } catch (e) { console.error('logout cleanup failed:', e); }
      auth = { status: 'unauthenticated' };
      json(res, 200, { ok: true });
      return;
    }

    // ---- データ ----
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, state);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      if (auth.status !== 'authenticated') { json(res, 401, { error: 'not authenticated' }); return; }
      const original = decodeURIComponent(req.headers['x-filename'] ?? 'photo.jpg');
      const ext = (path.extname(original) || '.jpg').toLowerCase();
      if (!MIME[ext]) { json(res, 400, { error: `unsupported file type: ${ext}` }); return; }
      const body = await readBody(req);
      if (body.length === 0) { json(res, 400, { error: 'empty body' }); return; }
      const id = crypto.randomUUID();
      const file = `${id}${ext}`;
      await writeFile(path.join(UPLOAD_DIR, file), body);
      state.photos.push({
        id, file, originalName: path.basename(original),
        uploadedAt: new Date().toISOString(),
        status: 'pending', issues: [], error: null,
      });
      save();
      pumpQueue();
      json(res, 200, { id });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const file = path.basename(url.pathname);
      const ext = path.extname(file).toLowerCase();
      try {
        const buf = await readFile(path.join(UPLOAD_DIR, file));
        res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
        res.end(buf);
      } catch { json(res, 404, { error: 'not found' }); }
      return;
    }
    const retryMatch = url.pathname.match(/^\/api\/photos\/([\w-]+)\/retry$/);
    if (req.method === 'POST' && retryMatch) {
      const photo = state.photos.find((p) => p.id === retryMatch[1]);
      if (!photo) { json(res, 404, { error: 'not found' }); return; }
      photo.status = 'pending';
      photo.error = null;
      save();
      pumpQueue();
      json(res, 200, { ok: true });
      return;
    }
    const delMatch = url.pathname.match(/^\/api\/photos\/([\w-]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      const i = state.photos.findIndex((p) => p.id === delMatch[1]);
      if (i < 0) { json(res, 404, { error: 'not found' }); return; }
      const [photo] = state.photos.splice(i, 1);
      unlink(path.join(UPLOAD_DIR, photo.file)).catch(() => {});
      save();
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`課題1000: listening on ${HOST}:${PORT} (DATA_DIR=${DATA_DIR}, auth=${auth.status})`);
});
