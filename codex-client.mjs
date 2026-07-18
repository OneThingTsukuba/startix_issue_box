// codex app-server (stdio, JSONL) との最小 JSON-RPC クライアント
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = [];
    this.initialized = null;
  }

  start() {
    this.proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        for (const h of this.notificationHandlers) h(msg);
      }
    });
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`app-server exited (${code})`));
      this.pending.clear();
    });
  }

  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(fn) {
    this.notificationHandlers.push(fn);
    return () => {
      const i = this.notificationHandlers.indexOf(fn);
      if (i >= 0) this.notificationHandlers.splice(i, 1);
    };
  }

  async init() {
    if (!this.initialized) {
      this.initialized = (async () => {
        this.start();
        const res = await this.request('initialize', {
          clientInfo: { name: 'startix-issue-box', version: '0.1.0' },
        });
        this.notify('initialized', {});
        return res;
      })();
    }
    return this.initialized;
  }

  close() {
    this.proc?.kill();
  }
}
