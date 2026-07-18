// 課題1000 集計サーバー: 画像アップロード → codex app-server で文字起こし・カテゴリ分け
import http from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
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
const PORT = Number(process.env.PORT ?? 3939);
const HOST = process.env.HOST ?? '0.0.0.0';

await mkdir(UPLOAD_DIR, { recursive: true });

// ---- 永続化 ----
let state = { photos: [] };
if (existsSync(DATA_FILE)) {
  try { state = JSON.parse(await readFile(DATA_FILE, 'utf8')); } catch {}
}
// 前回異常終了で processing のまま残ったものは pending に戻す
for (const p of state.photos) if (p.status === 'processing') p.status = 'pending';

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFile(DATA_FILE, JSON.stringify(state, null, 2)).catch(console.error), 200);
}

// ---- codex 処理キュー(直列) ----
const codex = new CodexClient();
let queueRunning = false;

async function pumpQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const photo = state.photos.find((p) => p.status === 'pending');
      if (!photo) break;
      photo.status = 'processing';
      save();
      try {
        const issues = await extractIssues(codex, path.join(UPLOAD_DIR, photo.file));
        photo.issues = issues;
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
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, state);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
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
      const file = path.basename(url.pathname); // パストラバーサル防止
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
  console.log(`課題1000: listening on ${HOST}:${PORT} (DATA_DIR=${DATA_DIR})`);
});
