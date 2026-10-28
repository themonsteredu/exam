// 저장소: 설정, 월별 사용 기록, 보관함 문서, 파일.
// 배포에서는 Supabase 함수 exam-gateway 를 거친다 (Vercel 은 Supabase 서비스 열쇠를 갖지 않는다).
// EXAM_STORE=local 이면 .data 폴더를 쓴다 (이 작업 환경에서 화면을 시험할 때만).

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appSecret } from "./session";

export type FileRef = { path: string; name: string; size: number; type: string };

export type DocRow = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  status: "reading" | "done" | "failed";
  original_files: FileRef[];
  hwpx_path: string | null;
  cost_usd: number;
  item_count: number;
  note: string | null;
  /** getDoc 에서만 들어 있다 (목록에서는 빼서 가볍게) */
  exam_json?: unknown;
};

export type DocPatch = Partial<Pick<DocRow, "title" | "status" | "original_files" | "hwpx_path" | "cost_usd" | "item_count" | "note" | "exam_json">>;

export type UsageRow = {
  kind: "page" | "figure" | "test";
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  usd: number;
  docId?: string;
};

export type MonthUsage = { month: string; calls: number; usd: number };

/** 로그인 시도 허락: id 가 null 이면 막힌 것. 숫자는 이 시도 전까지 틀린 횟수 (같은 곳 15분, 모두 15분, 모두 24시간) */
export type LoginGate = { id: number | null; ip: number; all: number; day: number };

/** 로그인 제한 (supabase/migrations/20261028_exam_login_begin.sql 과 같은 값) */
export const LOGIN_LIMIT = { ip: 10, all: 50, day: 200 };

export type SignedUpload = { url: string; headers: Record<string, string> };

export interface Store {
  getSettings(keys: string[]): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  addUsage(row: UsageRow): Promise<void>;
  monthlyUsage(months: number): Promise<MonthUsage[]>;
  /** 비밀번호를 확인하기 전에 부른다: 시도를 "틀림" 으로 먼저 적고 허락 여부를 돌려준다 (막히면 적지 않는다) */
  loginBegin(ip: string): Promise<LoginGate>;
  /** 비밀번호가 맞았을 때: 먼저 적은 시도를 "맞음" 으로 바꾼다 */
  loginSucceeded(id: number): Promise<void>;
  listDocs(limit: number, offset: number): Promise<DocRow[]>;
  getDoc(id: string): Promise<DocRow | null>;
  createDoc(title: string): Promise<DocRow>;
  updateDoc(id: string, patch: DocPatch): Promise<DocRow>;
  deleteDoc(id: string): Promise<void>;
  /** 브라우저가 파일을 바로 올릴 서명 주소 (PUT) */
  uploadUrl(filePath: string, contentType: string): Promise<SignedUpload>;
  /** 60초 동안 쓸 수 있는 내려받기 주소 */
  downloadUrl(filePath: string, downloadName?: string): Promise<string>;
}

/** 파일 경로: originals/<문서 id>/…, generated/<문서 id>/… 만 허용 (다른 앱 파일에 닿지 않게).
 *  Supabase 보관함은 한글 이름을 받지 않으므로 파일 이름은 영문·숫자로만 짓는다 (supabase/functions/exam-gateway 와 같은 규칙) */
export function isAllowedPath(p: string): boolean {
  return /^(originals|generated)\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}$/.test(p) && !p.includes("..");
}

/** 파일 이름의 확장자 (영문·숫자 8자까지, 없으면 fallback) */
export function fileExt(name: string, fallback = "bin"): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : fallback;
}

export const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 파일 이름에서 경로에 쓸 수 없는 글자를 뺀다 (한글은 그대로 둔다) */
export function safeName(name: string): string {
  const cleaned = name.normalize("NFC").replace(/[\\/:*?"<>|#%{}^~[\]`\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "file").slice(0, 120);
}

// ------------------------------------------------------------------ Supabase 함수 exam-gateway

class GatewayError extends Error {}

class GatewayStore implements Store {
  constructor(private url: string, private secret: string) {}

  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-exam-gateway": this.secret },
      body: JSON.stringify({ action, ...payload }),
      cache: "no-store",
    });
    const text = await res.text();
    let body: { ok?: boolean; data?: T; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new GatewayError(`저장소 응답을 읽지 못했습니다 (${res.status})`);
    }
    if (!res.ok || !body.ok) throw new GatewayError(`저장소 오류: ${body.error ?? res.status}`);
    return body.data as T;
  }

  getSettings(keys: string[]) {
    return this.call<Record<string, unknown>>("settings.get", { keys });
  }
  async setSetting(key: string, value: unknown) {
    await this.call("settings.set", { key, value });
  }
  async deleteSetting(key: string) {
    await this.call("settings.delete", { key });
  }
  async addUsage(row: UsageRow) {
    await this.call("usage.add", { row });
  }
  monthlyUsage(months: number) {
    return this.call<MonthUsage[]>("usage.monthly", { months });
  }
  loginBegin(ip: string) {
    return this.call<LoginGate>("login.begin", { ip });
  }
  async loginSucceeded(id: number) {
    await this.call("login.ok", { id });
  }
  listDocs(limit: number, offset: number) {
    return this.call<DocRow[]>("docs.list", { limit, offset });
  }
  getDoc(id: string) {
    return this.call<DocRow | null>("docs.get", { id });
  }
  createDoc(title: string) {
    return this.call<DocRow>("docs.create", { title });
  }
  updateDoc(id: string, patch: DocPatch) {
    return this.call<DocRow>("docs.update", { id, patch });
  }
  async deleteDoc(id: string) {
    await this.call("docs.delete", { id });
  }
  uploadUrl(filePath: string, contentType: string) {
    return this.call<SignedUpload>("files.uploadUrl", { path: filePath, contentType });
  }
  downloadUrl(filePath: string, downloadName?: string) {
    return this.call<string>("files.downloadUrl", { path: filePath, downloadName });
  }
}

// ------------------------------------------------------------------ 이 작업 환경용 (.data 폴더)

type LocalData = {
  settings: Record<string, unknown>;
  usage: (UsageRow & { at: string })[];
  logins: { id?: number; at: string; ok: boolean; ip: string }[];
  docs: DocRow[];
};

/** 개발용 파일 주소 서명 (app/api/dev-files 가 확인한다) */
export function devFileToken(filePath: string, mode: "put" | "get", exp: number): string {
  return createHmac("sha256", appSecret()).update(`${mode}:${filePath}:${exp}`).digest("hex");
}

export function checkDevFileToken(filePath: string, mode: "put" | "get", exp: number, token: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const want = Buffer.from(devFileToken(filePath, mode, exp));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const LOCAL_ROOT = path.join(process.cwd(), ".data");

class LocalStore implements Store {
  private file = path.join(LOCAL_ROOT, "store.json");
  private queue: Promise<unknown> = Promise.resolve();

  private async load(): Promise<LocalData> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return { settings: {}, usage: [], logins: [], docs: [] };
    }
  }

  /** 읽고 고쳐 쓰기를 한 줄로 세워 겹치지 않게 */
  private change<T>(fn: (d: LocalData) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const d = await this.load();
      const out = fn(d);
      await mkdir(LOCAL_ROOT, { recursive: true });
      await writeFile(this.file, JSON.stringify(d, null, 1));
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async getSettings(keys: string[]) {
    const d = await this.load();
    return Object.fromEntries(keys.filter((k) => k in d.settings).map((k) => [k, d.settings[k]]));
  }
  async setSetting(key: string, value: unknown) {
    await this.change((d) => {
      d.settings[key] = value;
    });
  }
  async deleteSetting(key: string) {
    await this.change((d) => {
      delete d.settings[key];
    });
  }
  async addUsage(row: UsageRow) {
    await this.change((d) => {
      d.usage.push({ ...row, at: new Date().toISOString() });
    });
  }
  async monthlyUsage(months: number) {
    const d = await this.load();
    const byMonth = new Map<string, MonthUsage>();
    for (const u of d.usage) {
      const month = u.at.slice(0, 7);
      const m = byMonth.get(month) ?? { month, calls: 0, usd: 0 };
      m.calls++;
      m.usd += u.usd;
      byMonth.set(month, m);
    }
    return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, months);
  }
  loginBegin(ip: string) {
    // change() 가 한 줄로 세우므로 동시에 와도 횟수가 어긋나지 않는다
    return this.change((d): LoginGate => {
      const now = Date.now();
      const failed = d.logins.filter((l) => !l.ok && now - Date.parse(l.at) < 86_400_000);
      const recent = failed.filter((l) => now - Date.parse(l.at) < 15 * 60_000);
      const gate = { ip: recent.filter((l) => l.ip === ip).length, all: recent.length, day: failed.length };
      if (gate.ip >= LOGIN_LIMIT.ip || gate.all >= LOGIN_LIMIT.all || gate.day >= LOGIN_LIMIT.day) return { id: null, ...gate };
      const id = (d.logins.reduce((m, l) => Math.max(m, l.id ?? 0), 0) || 0) + 1;
      d.logins.push({ id, at: new Date(now).toISOString(), ok: false, ip });
      d.logins = d.logins.slice(-500);
      return { id, ...gate };
    });
  }
  async loginSucceeded(id: number) {
    await this.change((d) => {
      const row = d.logins.find((l) => l.id === id);
      if (row) row.ok = true;
    });
  }
  async listDocs(limit: number, offset: number) {
    const d = await this.load();
    return d.docs
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit)
      .map(({ exam_json, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
  }
  async getDoc(id: string) {
    const d = await this.load();
    return d.docs.find((x) => x.id === id) ?? null;
  }
  createDoc(title: string) {
    return this.change((d) => {
      const now = new Date().toISOString();
      const doc: DocRow = {
        id: randomUUID(), created_at: now, updated_at: now, title, status: "reading",
        original_files: [], hwpx_path: null, cost_usd: 0, item_count: 0, note: null,
      };
      d.docs.push(doc);
      return doc;
    });
  }
  updateDoc(id: string, patch: DocPatch) {
    return this.change((d) => {
      const doc = d.docs.find((x) => x.id === id);
      if (!doc) throw new Error("문서를 찾지 못했습니다");
      Object.assign(doc, patch, { updated_at: new Date().toISOString() });
      return doc;
    });
  }
  async deleteDoc(id: string) {
    await this.change((d) => {
      d.docs = d.docs.filter((x) => x.id !== id);
    });
    for (const dir of ["originals", "generated"]) await rm(path.join(LOCAL_ROOT, "files", dir, id), { recursive: true, force: true });
  }
  async uploadUrl(filePath: string, contentType: string) {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const q = new URLSearchParams({ path: filePath, exp: String(exp), token: devFileToken(filePath, "put", exp) });
    return { url: `/api/dev-files?${q}`, headers: { "content-type": contentType || "application/octet-stream" } };
  }
  async downloadUrl(filePath: string, downloadName?: string) {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const q = new URLSearchParams({ path: filePath, exp: String(exp), token: devFileToken(filePath, "get", exp) });
    if (downloadName) q.set("download", downloadName);
    return `/api/dev-files?${q}`;
  }
}

let store: Store | null = null;

export function getStore(): Store {
  if (store) return store;
  if (process.env.EXAM_STORE === "local") {
    store = new LocalStore();
  } else {
    const url = process.env.EXAM_GATEWAY_URL;
    const secret = process.env.EXAM_GATEWAY_SECRET;
    if (!url || !secret) throw new Error("저장소 설정(EXAM_GATEWAY_URL, EXAM_GATEWAY_SECRET)이 없습니다");
    store = new GatewayStore(url, secret);
  }
  return store;
}
