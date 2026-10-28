// 저장소: 설정, 월별 사용 기록, 보관함 문서, 파일, 로그인 쿠키 서명 열쇠, 기기마다 따로 둔 API 키와 모델.
// 배포에서는 Supabase 함수 exam-gateway 를 거친다. Vercel 에는 비밀값이 없다:
//   Vercel 이 주는 OIDC 토큰(이 프로젝트에서 도는 코드라는 증명)으로 창구에 들어가고,
//   쿠키 서명 열쇠와 API 키 암호화는 창구가 맡는다 (Vercel 은 Supabase 서비스 열쇠도 갖지 않는다).
// EXAM_GATEWAY_SECRET 이 있으면 OIDC 대신 그 값으로 들어간다 (이 작업 환경에서 실제 창구를 시험할 때만).
// EXAM_STORE=local 이면 .data 폴더를 쓴다 (이 작업 환경에서 화면을 시험할 때만).

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getVercelOidcToken } from "@vercel/oidc";
import { openApiKey, sealApiKey, type SealedKey } from "./secrets";
import { appSecret } from "./session";

/** 저장 창구 주소 (비밀이 아니다) */
export const DEFAULT_GATEWAY_URL = "https://vypnobpmyadtcvxhtagn.supabase.co/functions/v1/exam-gateway";

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
  /** 어느 열쇠로 쓴 요금인지 묶는 표시 (열쇠의 SHA-256 앞 32자리) */
  keyTag?: string;
};

export type MonthUsage = { month: string; calls: number; usd: number };

/** 로그인 시도 허락: id 가 null 이면 막힌 것. 숫자는 이 시도 전까지 틀린 횟수 (같은 곳 15분, 모두 15분, 모두 24시간) */
export type LoginGate = { id: number | null; ip: number; all: number; day: number };

/** 로그인 제한 (supabase/migrations/20261028_exam_login_begin.sql 과 같은 값) */
export const LOGIN_LIMIT = { ip: 10, all: 50, day: 200 };

export type SignedUpload = { url: string; headers: Record<string, string> };

/** 기기에 저장된 API 키 정보 (키 자체는 없다). tag 는 이 열쇠로 쓴 요금을 묶는 표시 */
export type ApiKeyInfo = { saved: boolean; last4?: string; savedAt?: string; broken?: boolean; tag?: string };

/** 기기 하나의 AI 설정 (열쇠 자체는 없다). models 는 저장된 그대로 (auth.ts 의 pickModels 로 고른다) */
export type DeviceInfo = { apiKey: ApiKeyInfo; models: unknown };

/** AI 를 부를 때 쓰는 기기 설정 (열쇠 포함. 서버에서만) */
export type DeviceKey = { key: string | null; broken: boolean; tag: string | null; models: unknown };

/** 기기 값 (lib/server/device.ts 의 deviceTag: SHA-256 16진수) */
export const DEVICE = /^[0-9a-f]{64}$/;
const KEY_TAG = /^[0-9a-f]{32}$/;

export interface Store {
  getSettings(keys: string[]): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  addUsage(row: UsageRow): Promise<void>;
  /** 열쇠 하나(keyTag)로 쓴 달마다 요금 */
  monthlyUsage(keyTag: string, months: number): Promise<MonthUsage[]>;
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
  /** 로그인 쿠키 서명 열쇠 */
  sessionKey(): Promise<string>;
  /** 기기 하나의 AI 설정 (device 는 DEVICE 모양) */
  deviceInfo(device: string): Promise<DeviceInfo>;
  /** AI 를 부를 때만 쓴다. 풀 수 없으면 broken */
  getApiKey(device: string): Promise<DeviceKey>;
  setApiKey(device: string, key: string): Promise<ApiKeyInfo>;
  deleteApiKey(device: string): Promise<void>;
  setModels(device: string, models: { page: string; figure: string }): Promise<void>;
}

/** 같은 열쇠의 요금을 묶는 표시 (supabase/functions/exam-gateway 와 같은 계산). 열쇠를 되살릴 수 없다 */
export function keyTagOf(key: string): string {
  return createHash("sha256").update(`exam-key:${key}`).digest("hex").slice(0, 32);
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
  constructor(private url: string, private secret: string | undefined) {}

  /** 창구에 들어갈 증명: 이 작업 환경 시험은 공유 비밀값, 배포는 Vercel OIDC 토큰 (요청마다 새로 받는다) */
  private async proof(): Promise<Record<string, string>> {
    if (this.secret) return { "x-exam-gateway": this.secret };
    let token = "";
    try {
      token = await getVercelOidcToken();
    } catch {
      /* 아래에서 알린다 */
    }
    if (!token) throw new GatewayError("저장소에 들어갈 증명(Vercel OIDC)을 받지 못했습니다");
    return { "x-exam-oidc": token };
  }

  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await this.proof()) },
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
  monthlyUsage(keyTag: string, months: number) {
    return this.call<MonthUsage[]>("usage.monthly", { keyTag, months });
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
  async sessionKey() {
    return (await this.call<{ key: string }>("session.key")).key;
  }
  deviceInfo(device: string) {
    return this.call<DeviceInfo>("device.info", { device });
  }
  getApiKey(device: string) {
    return this.call<DeviceKey>("apikey.get", { device });
  }
  setApiKey(device: string, key: string) {
    return this.call<ApiKeyInfo>("apikey.set", { device, key });
  }
  async deleteApiKey(device: string) {
    await this.call("apikey.delete", { device });
  }
  async setModels(device: string, models: { page: string; figure: string }) {
    await this.call("models.set", { device, models });
  }
}

// ------------------------------------------------------------------ 이 작업 환경용 (.data 폴더)

type LocalDevice = { sealed?: SealedKey; tag?: string; models?: unknown };

type LocalData = {
  settings: Record<string, unknown>;
  devices?: Record<string, LocalDevice>;
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
  async monthlyUsage(keyTag: string, months: number) {
    const d = await this.load();
    const byMonth = new Map<string, MonthUsage>();
    for (const u of d.usage) {
      if (!KEY_TAG.test(keyTag) || u.keyTag !== keyTag) continue;
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
  async sessionKey() {
    return appSecret();
  }
  private async device(device: string): Promise<LocalDevice> {
    if (!DEVICE.test(device)) throw new Error("기기 값이 이상합니다");
    return (await this.load()).devices?.[device] ?? {};
  }
  private changeDevice(device: string, fn: (v: LocalDevice) => void): Promise<void> {
    if (!DEVICE.test(device)) throw new Error("기기 값이 이상합니다");
    return this.change((d) => {
      d.devices ??= {};
      fn((d.devices[device] ??= {}));
    });
  }
  async deviceInfo(device: string): Promise<DeviceInfo> {
    const v = await this.device(device);
    const apiKey: ApiKeyInfo = v.sealed
      ? { saved: true, last4: v.sealed.last4, savedAt: v.sealed.saved_at, broken: !openApiKey(v.sealed), tag: v.tag }
      : { saved: false };
    return { apiKey, models: v.models ?? null };
  }
  async getApiKey(device: string): Promise<DeviceKey> {
    const v = await this.device(device);
    const key = v.sealed ? openApiKey(v.sealed) : null;
    return { key, broken: !!v.sealed && !key, tag: v.tag ?? null, models: v.models ?? null };
  }
  async setApiKey(device: string, key: string) {
    const sealed = sealApiKey(key);
    const tag = keyTagOf(key);
    await this.changeDevice(device, (v) => {
      v.sealed = sealed;
      v.tag = tag;
    });
    return { saved: true, last4: sealed.last4, savedAt: sealed.saved_at, broken: false, tag };
  }
  async deleteApiKey(device: string) {
    await this.changeDevice(device, (v) => {
      delete v.sealed;
      delete v.tag;
    });
  }
  async setModels(device: string, models: { page: string; figure: string }) {
    await this.changeDevice(device, (v) => {
      v.models = models;
    });
  }
}

let store: Store | null = null;

export function getStore(): Store {
  if (store) return store;
  if (process.env.EXAM_STORE === "local") {
    store = new LocalStore();
  } else {
    store = new GatewayStore(process.env.EXAM_GATEWAY_URL || DEFAULT_GATEWAY_URL, process.env.EXAM_GATEWAY_SECRET || undefined);
  }
  return store;
}
