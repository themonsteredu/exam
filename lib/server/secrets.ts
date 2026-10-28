// 비밀번호 해시(scrypt)와 API 키 암호화(AES-256-GCM). 서버(Node)에서만 쓴다.
// API 키는 DB 에 암호문으로만 두고, AI 를 부를 때 서버에서만 푼다. 화면에는 끝 4자리만 보여 준다.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { appSecret } from "./session";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: unknown): boolean {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  if (!N || !r || !p || !want.length) return false;
  const got = scryptSync(password, salt, want.length, { N, r, p });
  return got.length === want.length && timingSafeEqual(got, want);
}

export type SealedKey = { v: 1; iv: string; tag: string; data: string; last4: string; saved_at: string };

function keyFor(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret(), "exam-maker", purpose, 32));
}

export function sealApiKey(apiKey: string, now = new Date()): SealedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor("anthropic-api-key-v1"), iv);
  const data = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    last4: apiKey.slice(-4),
    saved_at: now.toISOString(),
  };
}

export function openApiKey(sealed: unknown): string | null {
  const s = sealed as Partial<SealedKey> | null;
  if (!s || s.v !== 1 || !s.iv || !s.tag || !s.data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor("anthropic-api-key-v1"), Buffer.from(s.iv, "base64"));
    decipher.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(s.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // APP_SECRET 이 바뀌었거나 값이 망가짐 → 키를 다시 넣어야 한다
    return null;
  }
}
