// Network-isolated provider regression: never sends a paid AI request.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { callAI } from "@/lib/ai/client";
import { openAIUsage, openAIErrorDetail, type OpenAIResponse } from "@/lib/ai/openai";
import { ReadError } from "@/lib/ai/claude";
import { readPage } from "@/lib/ai/read-page";
import { fakePage } from "@/lib/ai/fake";
import { pageReadingJsonSchema } from "@/lib/ai/page-schema";
import { validApiKeyFormat } from "@/lib/ai/models";

const page = fakePage().reading;
const image = { data: "dGVzdA==", mediaType: "image/png" as const, width: 1126, height: 1661 };
const gptKey = "sk-proj-fixture-only-" + "a".repeat(40);
const claudeKey = "sk-ant-api03-fixture-only-" + "b".repeat(40);
const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-encrypted-reasoning" };
function completed(text = JSON.stringify(page), overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: "resp_fixture", model: "gpt-6.1-sol", status: "completed",
    output: [reasoning, { type: "message", id: "msg_fixture", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } },
    ...overrides,
  };
}
function stream(response = completed()): Response {
  const event = response.status === "completed" ? "response.completed" : response.status === "incomplete" ? "response.incomplete" : "response.failed";
  const bytes = new TextEncoder().encode(
    ": keepalive\r\n\r\ndata: " + JSON.stringify({ type: "response.output_text.delta", delta: "문항" }) +
    "\r\n\r\ndata: " + JSON.stringify({ type: event, response }) + "\r\n\r\n",
  );
  let cursor = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(cursor, cursor += 17));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
function rejected(status: number, code: string, message = code): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "x-request-id": "req_fixture", "retry-after": "0" } });
}
const savedFetch = globalThis.fetch;
let calls: { url: string; body: any; auth: string | null }[] = [];
let respond: (n: number, request: Request) => Response = () => stream();
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.ok(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/models"].includes(request.url), "No other network requests are allowed");
  calls.push({ url: request.url, body: request.method === "POST" ? await request.json() : null, auth: request.headers.get("authorization") });
  return respond(calls.length, request);
};
const read = () => readPage(image, { page: 1, total: 1, model: "gpt-6.1-sol", apiKey: gptKey, deadline: Date.now() + 280_000 });
const request = { system: "Return JSON", model: "gpt-6.1-sol", messages: [{ role: "user" as const, content: "test" }], effort: "high" as const, maxTokens: 32000, jsonSchema: pageReadingJsonSchema(), apiKey: gptKey };
const direct = () => callAI(request);
const expectCode = (code: string) => (error: unknown) => error instanceof ReadError && error.code === code;
const oldCwd = process.cwd();
const scratch = await mkdtemp(path.join(tmpdir(), "exam-openai-test-"));
try {
  const result = await read();
  assert.deepEqual(result.reading.sections, page.sections);
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(calls[0].auth, "Bearer " + gptKey);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.store, false);
  assert.equal(body.service_tier, "default");
  assert.deepEqual(body.reasoning, { effort: "medium", context: "all_turns" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.input[1].content[0].detail, "original");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.max_output_tokens, 32000);
  assert.equal(body.input[0].content[0].prompt_cache_breakpoint.mode, "explicit");
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.deepEqual(result.usage, { model: "gpt-6.1-sol", input: 500, output: 500, cacheRead: 200, cacheWrite: 300, usd: 0.00677 });

  calls = [];
  respond = n => stream(completed(n === 1 ? "{}" : JSON.stringify(page)));
  const repaired = await read();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.input[2], reasoning, "Replay encrypted reasoning unchanged");
  assert.equal(calls[1].body.input[3].phase, "final_answer");
  assert.equal(calls[1].body.prompt_cache_options.comparison_response_id, "resp_fixture");
  assert.deepEqual(calls[1].body.input[1], calls[0].body.input[1], "Keep source image in repair");
  assert.equal(repaired.usage.output, 1000);
  assert.equal(repaired.usage.usd, 0.01354);

  // A page can pass the JSON schema while returning only ①'s diagram for five picture choices.
  const diagramChoices = structuredClone(page);
  const question = diagramChoices.sections[0].items[0];
  question.choices = [[], [], [], [], []];
  question.figures = Array.from({ length: 5 }, (_, i) => ({
    x: 40 + (i % 2) * 140, y: 330 + Math.floor(i / 2) * 100, w: 100, h: 70,
    place: "below" as const, kind: "diagram" as const,
  }));
  const partialChoices = structuredClone(diagramChoices);
  partialChoices.sections[0].items[0].figures.splice(1);
  calls = [];
  respond = n => stream(completed(JSON.stringify(n === 1 ? partialChoices : diagramChoices)));
  const choiceRepair = await read();
  assert.equal(choiceRepair.reading.sections[0].items[0].figures.length, 5);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.input.at(-1).content, /선택지 5개.*그림 영역이 1개/);

  const wrongCoordinates = structuredClone(diagramChoices);
  wrongCoordinates.sections[0].items[0].figures[0] = {
    ...question.figures[0], x: 0.1, y: 0.2, w: 0.2, h: 0.1,
  };
  calls = [];
  respond = n => n === 1 ? stream(completed(JSON.stringify(wrongCoordinates))) : rejected(400, "invalid_image");
  const retained = await read();
  assert.equal(retained.reading.sections[0].items[0].choices.length, 5);
  assert.equal(retained.figureReviewNeeded, true);
  assert.match(retained.reading.sections[0].items[0].unsure.join(" "), /픽셀 범위/);
  assert.equal(calls.length, 2);

  calls = [];
  respond = n => n === 1 ? rejected(400, "invalid_json_schema", "text.format schema unsupported") : stream();
  await read();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.text.format.type, "json_object");
  assert.equal(calls[1].body.model, calls[0].body.model);
  assert.ok(calls[1].body.input[0].content[0].text.includes('"sections"'));

  for (const [status, code] of [[401, "invalid_api_key"], [429, "insufficient_quota"], [400, "invalid_image"]] as const) {
    calls = [];
    respond = () => rejected(status, code);
    await assert.rejects(direct, expectCode("api"));
    assert.equal(calls.length, 1, "Do not retry authentication, credit, or image failures");
  }
  calls = [];
  respond = n => n === 1 ? rejected(503, "overloaded") : stream();
  await direct();
  assert.equal(calls.length, 2);

  for (const [response, code] of [
    [completed("", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), "too_long"],
    [completed("", { output: [{ type: "message", content: [{ type: "refusal", refusal: "fixture" }] }] }), "refusal"],
    [completed(""), "bad_answer"],
    [completed("", { status: "failed", error: { message: "fixture" } }), "api"],
  ] as const) {
    calls = [];
    respond = () => stream(response);
    await assert.rejects(direct, (error: unknown) => expectCode(code)(error) && (error as ReadError).usage?.output === 500);
    assert.equal(calls.length, 1);
  }
  calls = [];
  respond = () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
  await assert.rejects(direct, (error: unknown) => expectCode("bad_answer")(error) && !!(error as ReadError).usage);
  calls = [];
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => callAI({ ...request, signal: cancelled.signal }));
  assert.equal(calls.length, 0);
  await assert.rejects(() => callAI({ ...request, deadline: Date.now() + 1000 }), expectCode("timeout"));
  assert.equal(calls.length, 0);

  const cached = completed("", { usage: { input_tokens: 1000, output_tokens: 0, input_tokens_details: { cached_tokens: 1000 } } });
  assert.equal(openAIUsage(cached, "gpt-6-astra").usd, 0.001, "Astra cached input is $1/M");
  assert.equal(openAIUsage(cached, "gpt-6.1-sol").usd, 0.0001);
  const long = completed("", { usage: { input_tokens: 300000, output_tokens: 1000 } });
  assert.equal(openAIUsage(long, "gpt-6.1-sol").usd, 1.215);
  const safe = openAIErrorDetail(400, gptKey + " Bearer private data:image/png;base64," + "A".repeat(250), "req_safe");
  assert.ok(!safe.includes(gptKey) && !safe.includes("Bearer private") && !safe.includes("A".repeat(100)));
  assert.ok(safe.includes("req_safe"));
  assert.ok(validApiKeyFormat(gptKey, "openai"));
  assert.ok(!validApiKeyFormat(claudeKey, "openai"));
  assert.ok(!validApiKeyFormat(gptKey, "anthropic"));

  // Initialize the real local store in a unique disposable directory.
  process.chdir(scratch);
  process.env.EXAM_STORE = "local";
  process.env.EXAM_FAKE_AI = "0";
  process.env.APP_SECRET = "fixture-openai-regression-secret-0123456789";
  const { getStore, apiKeyDevice } = await import("@/lib/server/store");
  const { newDeviceId, deviceTag } = await import("@/lib/server/device");
  const { makeSessionToken } = await import("@/lib/server/session");
  const { aiConfig } = await import("@/lib/server/auth");
  const keys = await import("@/app/api/settings/api-key/route");
  const settings = await import("@/app/api/settings/route");
  const modelSettings = await import("@/app/api/settings/models/route");
  const store = getStore();
  const deviceId = newDeviceId();
  const device = await deviceTag(deviceId);
  const token = await makeSessionToken(1, process.env.APP_SECRET);
  const cookie = "exam_session=" + token.token + "; exam_device=" + deviceId;
  const req = (url: string, method = "GET", body?: unknown, withCookie = true) => new Request("http://localhost" + url, {
    method, headers: { ...(withCookie ? { cookie } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await store.setApiKey(device, claudeKey);
  assert.equal(apiKeyDevice(device, "anthropic"), device);
  assert.notEqual(apiKeyDevice(device, "openai"), device);
  calls = [];
  respond = () => Response.json({ data: [] });
  assert.equal((await keys.POST(req("/api/settings/api-key", "POST", { provider: "openai", key: gptKey }))).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/models", "Key validation must not call paid inference");
  assert.equal((await store.getApiKey(device)).key, claudeKey);
  assert.equal((await store.getApiKey(apiKeyDevice(device, "openai"))).key, gptKey);
  assert.equal((await keys.POST(req("/api/settings/api-key", "POST", { provider: "openai", key: claudeKey }))).status, 400);
  assert.equal((await keys.POST(req("/api/settings/api-key", "POST", { provider: "openai", key: gptKey }, false))).status, 401);
  assert.equal(calls.length, 1);

  assert.equal((await modelSettings.POST(req("/api/settings/models", "POST", { page: "gpt-6.1-sol", figure: "claude-opus-5-5" }))).status, 200);
  const pageConfig = await aiConfig(req("/"), "page");
  const figureConfig = await aiConfig(req("/"), "figure");
  assert.equal(pageConfig.apiKey, gptKey);
  assert.equal(figureConfig.apiKey, claudeKey);
  assert.equal((await aiConfig(req("/"), "figure", "gpt-6-astra")).apiKey, gptKey);
  assert.equal((await aiConfig(req("/", "GET", undefined, false), "page", "gpt-6.1-sol")).apiKey, null);
  await store.addUsage({ kind: "page", model: "gpt-6.1-sol", input: 100, output: 100, cacheRead: 0, cacheWrite: 0, usd: 0.01, keyTag: pageConfig.keyTag! });
  await store.addUsage({ kind: "figure", model: "claude-opus-5-5", input: 100, output: 100, cacheRead: 0, cacheWrite: 0, usd: 0.02, keyTag: figureConfig.keyTag! });
  const metadata = await (await settings.GET(req("/api/settings"))).json();
  assert.equal(metadata.canRead, true);
  assert.equal(metadata.usageByProvider.openai[0].usd, 0.01);
  assert.equal(metadata.usageByProvider.anthropic[0].usd, 0.02);
  assert.equal(metadata.usage[0].usd, 0.03);
  const publicJson = JSON.stringify(metadata);
  assert.ok(!publicJson.includes(gptKey) && !publicJson.includes(claudeKey) && !publicJson.includes(pageConfig.keyTag!));

  assert.equal((await keys.DELETE(req("/api/settings/api-key?provider=openai", "DELETE"))).status, 200);
  assert.equal((await store.getApiKey(device)).key, claudeKey, "Deleting GPT must preserve Claude");
  assert.equal((await aiConfig(req("/"), "page")).apiKey, null, "Missing GPT must never fall back to Claude key");
  assert.equal((await (await settings.GET(req("/api/settings"))).json()).canRead, false);
  assert.equal((await keys.DELETE(req("/api/settings/api-key?provider=unknown", "DELETE"))).status, 400);
  console.log("GPT Responses, stream repair, errors, usage, key isolation, mixed models and settings passed (no paid AI).");
} finally {
  globalThis.fetch = savedFetch;
  process.chdir(oldCwd);
  await rm(scratch, { recursive: true, force: true });
}

