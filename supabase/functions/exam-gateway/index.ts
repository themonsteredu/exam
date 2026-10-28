// 시험지 만들기 앱(exam)의 저장소 창구 (Supabase Edge Function, Deno).
// Vercel 서버는 Supabase 서비스 열쇠를 갖지 않고 이 함수만 부른다. 이 함수는 exam_* 표와 exam-files 보관함만 다룬다.
// 머리말 x-exam-gateway 의 값을 SHA-256 으로 바꾼 것이 exam_settings.gateway_secret_sha256 과 같을 때만 일한다.
// 배포: Supabase MCP deploy_edge_function (name exam-gateway, verify_jwt false: 위의 비밀값으로 직접 확인)
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "exam-files";
const HIDDEN = new Set(["gateway_secret_sha256"]);
// 보관함 파일 이름은 영문·숫자만 (Supabase 보관함이 한글 이름을 받지 않는다). 한글 원래 이름은 내려받을 때 붙인다.
const PATH = /^(originals|generated)\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOC_FIELDS = "id,created_at,updated_at,title,status,original_files,hwpx_path,cost_usd,item_count,note";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let cached: { hash: string | null; at: number } | null = null;

async function expectedHash(): Promise<string | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.hash;
  const { data } = await db.from("exam_settings").select("value").eq("key", "gateway_secret_sha256").maybeSingle();
  const hash = typeof data?.value === "string" ? data.value : null;
  cached = { hash, at: Date.now() };
  return hash;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
const ok = (data: unknown) => reply(200, { ok: true, data });
const bad = (status: number, error: string) => reply(status, { ok: false, error });

// deno-lint-ignore no-explicit-any
function doc(row: any) {
  return row ? { ...row, cost_usd: Number(row.cost_usd ?? 0), item_count: Number(row.item_count ?? 0) } : null;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

Deno.serve(async (req) => {
  if (req.method !== "POST") return bad(405, "POST only");
  const given = req.headers.get("x-exam-gateway") ?? "";
  const want = await expectedHash();
  if (!want || !given || !same(await sha256Hex(given), want)) return bad(401, "unauthorized");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return bad(400, "bad json");
  }

  try {
    switch (body.action) {
      case "settings.get": {
        const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k: unknown) => typeof k === "string" && !HIDDEN.has(k));
        if (!keys.length) return ok({});
        const { data, error } = await db.from("exam_settings").select("key,value").in("key", keys);
        if (error) throw error;
        return ok(Object.fromEntries((data ?? []).map((r) => [r.key, r.value])));
      }
      case "settings.set": {
        if (typeof body.key !== "string" || !body.key || HIDDEN.has(body.key)) return bad(400, "bad key");
        const { error } = await db
          .from("exam_settings")
          .upsert({ key: body.key, value: body.value ?? null, updated_at: new Date().toISOString() });
        if (error) throw error;
        return ok(null);
      }
      case "settings.delete": {
        if (typeof body.key !== "string" || HIDDEN.has(body.key)) return bad(400, "bad key");
        const { error } = await db.from("exam_settings").delete().eq("key", body.key);
        if (error) throw error;
        return ok(null);
      }
      case "usage.add": {
        const r = body.row ?? {};
        const kind = ["page", "figure", "test"].includes(r.kind) ? r.kind : "test";
        const { error } = await db.from("exam_usage").insert({
          kind,
          model: String(r.model ?? "").slice(0, 120),
          input_tokens: num(r.input),
          output_tokens: num(r.output),
          cache_write_tokens: num(r.cacheWrite),
          cache_read_tokens: num(r.cacheRead),
          usd: Number.isFinite(Number(r.usd)) ? Number(r.usd) : 0,
          doc_id: typeof r.docId === "string" && UUID.test(r.docId) ? r.docId : null,
        });
        if (error) throw error;
        return ok(null);
      }
      case "usage.monthly": {
        const { data, error } = await db.rpc("exam_usage_monthly", { months: Math.min(60, Math.max(1, num(body.months) || 12)) });
        if (error) throw error;
        return ok((data ?? []).map((r: { month: string; calls: number; usd: number }) => ({ month: r.month, calls: Number(r.calls), usd: Number(r.usd) })));
      }
      case "login.begin": {
        // 시도를 먼저 "틀림" 으로 적고 허락 여부를 돌려준다 (supabase/migrations/20261028_exam_login_begin.sql)
        const { data, error } = await db.rpc("exam_login_begin", { p_ip: String(body.ip ?? "").slice(0, 100) });
        if (error) throw error;
        const r = (Array.isArray(data) ? data[0] : data) ?? {};
        return ok({
          id: r.attempt_id == null ? null : Number(r.attempt_id),
          ip: Number(r.ip_recent ?? 0),
          all: Number(r.all_recent ?? 0),
          day: Number(r.all_day ?? 0),
        });
      }
      case "login.ok": {
        const id = Number(body.id);
        if (!Number.isSafeInteger(id) || id <= 0) return bad(400, "bad id");
        const { error } = await db.from("exam_login_attempts").update({ ok: true }).eq("id", id);
        if (error) throw error;
        return ok(null);
      }
      case "docs.list": {
        const limit = Math.min(100, Math.max(1, num(body.limit) || 50));
        const offset = num(body.offset);
        const { data, error } = await db
          .from("exam_documents")
          .select(DOC_FIELDS)
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (error) throw error;
        return ok((data ?? []).map(doc));
      }
      case "docs.get": {
        if (!UUID.test(String(body.id))) return ok(null);
        const { data, error } = await db.from("exam_documents").select("*").eq("id", body.id).maybeSingle();
        if (error) throw error;
        return ok(doc(data));
      }
      case "docs.create": {
        const { data, error } = await db
          .from("exam_documents")
          .insert({ title: String(body.title ?? "").slice(0, 200) })
          .select(DOC_FIELDS)
          .single();
        if (error) throw error;
        return ok(doc(data));
      }
      case "docs.update": {
        if (!UUID.test(String(body.id))) return bad(404, "no doc");
        const p = body.patch ?? {};
        // deno-lint-ignore no-explicit-any
        const patch: Record<string, any> = { updated_at: new Date().toISOString() };
        for (const k of ["title", "status", "original_files", "hwpx_path", "exam_json", "cost_usd", "item_count", "note"]) {
          if (k in p) patch[k] = p[k];
        }
        const { data, error } = await db.from("exam_documents").update(patch).eq("id", body.id).select(DOC_FIELDS).single();
        if (error) throw error;
        return ok(doc(data));
      }
      case "docs.delete": {
        if (!UUID.test(String(body.id))) return bad(404, "no doc");
        const paths: string[] = [];
        for (const dir of ["originals", "generated"]) {
          const { data } = await db.storage.from(BUCKET).list(`${dir}/${body.id}`, { limit: 1000 });
          for (const f of data ?? []) paths.push(`${dir}/${body.id}/${f.name}`);
        }
        if (paths.length) {
          const { error } = await db.storage.from(BUCKET).remove(paths);
          if (error) throw error;
        }
        const { error } = await db.from("exam_documents").delete().eq("id", body.id);
        if (error) throw error;
        return ok(null);
      }
      case "files.uploadUrl": {
        const path = String(body.path ?? "");
        if (!PATH.test(path) || path.includes("..")) return bad(400, "bad path");
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
        if (error) throw error;
        const contentType = typeof body.contentType === "string" && body.contentType ? body.contentType : "application/octet-stream";
        return ok({ url: data.signedUrl, headers: { "content-type": contentType, "x-upsert": "true" } });
      }
      case "files.downloadUrl": {
        const path = String(body.path ?? "");
        if (!PATH.test(path) || path.includes("..")) return bad(400, "bad path");
        // 내려받을 때 붙일 이름(한글 가능). supabase-js 의 download 옵션은 이름을 두 번 바꿔(인코딩) 한글이 깨지므로
        // 주소에 한 번만 바꿔 붙인다. 그러면 Supabase 가 filename*=UTF-8'' 로 제대로 된 이름을 준다.
        const name = typeof body.downloadName === "string" ? body.downloadName.replace(/[/\\\u0000-\u001f]/g, "_").slice(0, 150) : "";
        const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 60);
        if (error) throw error;
        return ok(`${data.signedUrl}&download=${encodeURIComponent(name)}`);
      }
      default:
        return bad(400, "unknown action");
    }
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
    console.error(body?.action, message);
    return bad(500, message.slice(0, 300));
  }
});
