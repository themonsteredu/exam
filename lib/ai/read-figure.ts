// 2차 읽기: 그림 하나(잘라서 키운 사진) + 문제 글 → 그림 명령.
// 받은 그림 명령은 바로 검사하고, 틀린 곳이 있으면 그 내용을 돌려보내 한 번 더 고쳐 받는다.
// 서버 전용 (Claude 를 부른다).

import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { checkFigureSpec } from "@/lib/figure/validate";
import {
  degreeMismatches,
  degreeMismatchNote,
  degreeMismatchText,
  repairDegrees,
  SHAPE_DEVIATION_LIMIT,
  shapeDeviation,
  shapeDeviationNote,
  shapeDeviationText,
  uprightFigure,
  withShape,
  worthReporting,
} from "@/lib/figure/review";
import type { FigureSpec, PointRef } from "@/lib/figure/types";
import { addUsage, assistantTurn, callClaude, extractJson, modelFor, ReadError, type Effort, type Usage } from "./claude";
import type { Piece, Region } from "./page-schema";
import { FIGURE_SYSTEM, figureRepairText, figureUserText, piecesToText } from "./prompts";
import type { ImageInput } from "./read-page";
import type { GraphicSpec } from "@/lib/graphic/schema";

export const FIGURE_EFFORT: Effort = "high";

const AnswerS = z.object({
  commands: z.unknown(),
  anchors: z.array(z.unknown()).catch([]).default([]),
  content_box: z.unknown().optional(),
  unsure: z.array(z.string()).catch([]).default([]),
  notes: z.string().catch("").default(""),
});

const AnchorS = z.strictObject({
  at: z.union([z.string().min(1), z.tuple([z.number(), z.number()])]),
  px: z.tuple([z.number(), z.number()]),
});

const BoxS = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });

export type Anchor = { at: PointRef; px: [number, number] };

export type FigureReading = {
  graphic?: GraphicSpec;
  /** 검사를 통과한 그림 명령 (끝내 통과하지 못하면 없음) */
  commands?: FigureSpec;
  /** 검사를 통과하지 못한 마지막 그림 명령 (확인 화면에서 고치도록) */
  rawCommands?: unknown;
  /** 보낸 사진 속 점 자리 (픽셀) */
  anchors: Anchor[];
  /** 보낸 사진에서 그림이 차지하는 사각형 (픽셀) */
  contentBox?: Region;
  unsure: string[];
  notes: string;
  /** 남은 문제 (비어 있으면 그릴 수 있음) */
  errors: string[];
  /** 그릴 수는 있지만 원본·조건과 달라 보이는 곳 (AI 에게 한 번 돌려보내 살피게 한다. 끝까지 남으면 unsure 에 짧게 적는다) */
  advice?: string[];
  /** advice 와 짝을 이루는 짧은 문장 (확인할 곳에 적는다) */
  adviceNotes?: string[];
  /** 프로그램이 AI 없이 고친 곳 (각 글자에 맞게 방향각을 뒤집는 등) */
  fixes?: string[];
  warnings: string[];
  /** AI 에게 물은 횟수 (고쳐 받은 횟수 + 1) */
  attempts: number;
};

export type FigureContext = {
  no: number | string;
  stem: Piece[] | { t?: string; m?: string }[];
  choices: (Piece[] | { t?: string; m?: string }[])[];
  bogi: (Piece[] | { t?: string; m?: string }[])[];
};

export async function readFigure(
  image: ImageInput,
  item: FigureContext,
  o: { model?: string; effort?: Effort; maxAttempts?: number; apiKey?: string; signal?: AbortSignal; deadline?: number; hint?: string; pageUpright?: boolean } = {},
): Promise<{ figure: FigureReading; usage: Usage }> {
  const model = modelFor("figure", o.model);
  const maxAttempts = o.maxAttempts ?? 2;
  const messages: BetaMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        {
          type: "text",
          text: figureUserText({
            no: item.no,
            width: image.width,
            height: image.height,
            stem: piecesToText(item.stem),
            choices: item.choices.map(piecesToText),
            bogi: item.bogi.map(piecesToText),
            hint: o.hint,
          }),
        },
      ],
    },
  ];
  let usage: Usage | undefined;
  let result: FigureReading | undefined;
  /** 그릴 수 있었던 마지막 답 (고쳐 받은 답이 오히려 망가지면 이것을 돌려준다) */
  let lastDrawable: FigureReading | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let call;
    try {
      call = await callClaude({
        system: FIGURE_SYSTEM,
        messages,
        model,
        apiKey: o.apiKey,
        effort: o.effort ?? FIGURE_EFFORT,
        maxTokens: 32000,
        signal: o.signal,
        deadline: o.deadline,
      });
    } catch (err) {
      // 살펴 달라고 다시 묻다가 실패(시간 초과·AI 서버 바쁨 등)해도, 그릴 수 있던 앞 답이 있으면 그것을 쓴다 (빈 자리가 되거나 처음부터 다시 사지 않게)
      if (lastDrawable && usage && !o.signal?.aborted) {
        if (err instanceof ReadError && err.usage) usage = addUsage(usage, err.usage);
        result = lastDrawable;
        break;
      }
      // 앞서 고쳐 받느라 쓴 토큰도 요금 기록에 넣게 붙여 보낸다
      if (err instanceof ReadError && usage) err.usage = err.usage ? addUsage(usage, err.usage) : usage;
      throw err;
    }
    usage = addUsage(usage, call.usage);
    result = judge(call.text, image, attempt, o.pageUpright !== false);
    if (result.commands && !result.errors.length) lastDrawable = result;
    if ((!result.errors.length && !result.advice?.length) || attempt === maxAttempts) break;
    // 고쳐 받을 시간이 모자라면 그대로 돌려준다 (서버 함수 시간 한도를 넘겨 이미 받은 답까지 잃지 않게)
    if (o.deadline && o.deadline - Date.now() < 120_000) break;
    messages.push(assistantTurn(call.message), { role: "user", content: figureRepairText(result.errors, result.advice ?? [], result.fixes ?? []) });
  }
  // 살펴 달라고 다시 물었는데 고친 답에 고칠 곳(오류)이 생겼으면, 그릴 수 있었던 앞 답을 쓴다 (그려지던 그림이 빈 자리가 되지 않게)
  if (result!.errors.length && lastDrawable) result = { ...lastDrawable, attempts: result!.attempts };
  // 끝까지 남은 살필 곳은 확인할 곳에 짧게 남긴다 (그림은 그대로 쓴다)
  if (result!.adviceNotes?.length) result!.unsure = [...result!.unsure, ...result!.adviceNotes];
  return { figure: result!, usage: usage! };
}

/** AI 의 답을 읽고 검사한다 */
export function judge(text: string, image: { width: number; height: number }, attempt = 1, pageUpright = true): FigureReading {
  const base: FigureReading = { anchors: [], unsure: [], notes: "", errors: [], warnings: [], attempts: attempt };
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return { ...base, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const answer = AnswerS.safeParse(json);
  if (!answer.success) return { ...base, errors: ["답은 {\"commands\": …, \"anchors\": …} 모양의 JSON 이어야 합니다"] };
  const a = answer.data;
  const check = checkFigureSpec(a.commands);
  const ids = new Set(((check.spec?.points ?? []) as { id: string }[]).map((p) => p.id));
  const anchors: Anchor[] = [];
  const warnings = [...check.warnings];
  for (const raw of a.anchors) {
    const anchor = AnchorS.safeParse(raw);
    if (!anchor.success) continue;
    const { at, px } = anchor.data;
    if (typeof at === "string" && check.spec && !ids.has(at)) {
      warnings.push(`겹쳐 보기 기준점 '${at}' 이 그림 명령에 없어 뺐습니다`);
      continue;
    }
    if (px[0] < -image.width * 0.1 || px[0] > image.width * 1.1 || px[1] < -image.height * 0.1 || px[1] > image.height * 1.1) continue;
    anchors.push({ at: at as PointRef, px });
  }
  const box = BoxS.safeParse(a.content_box);
  const contentBox = box.success ? clampBox(box.data, image) : undefined;
  // 그릴 수 있는 그림은 원본·조건과 맞는지 더 살핀다:
  //  1) 숫자 각 글자와 그린 각이 다르면 방향각을 헷갈린 실수부터 AI 없이 고쳐 본다 (2026-11-01 삼육중 2번)
  //  2) 그래도 다르거나, 원본 사진 속 점 자리와 모양이 크게 다르면(삼육중 서답형 2) AI 에게 한 번 살피게 한다
  let spec = check.spec;
  const fixes: string[] = [];
  const advice: string[] = [];
  const adviceNotes: string[] = [];
  if (spec) {
    // 원본 사진과 다른 방향(옆으로 눕거나 거꾸로)으로 그렸으면 먼저 원본 방향으로 돌린다.
    // 쪽이 바로 선 것으로 확인된 경우만 (누운 쪽 사진을 보고 바로 세워 그린 그림을 다시 눕히지 않게)
    const up = pageUpright && anchors.length ? uprightFigure(spec, anchors) : undefined;
    if (up) {
      spec = up.spec;
      fixes.push(up.change);
    }
    const fixed = repairDegrees(spec, anchors);
    if (fixed) {
      spec = fixed.spec;
      fixes.push(...fixed.changes);
    }
    const shape = anchors.length ? shapeDeviation(spec, anchors) : undefined;
    for (const m of withShape(degreeMismatches(spec), shape)) {
      // 원본 그림 자체가 조건과 맞지 않는 시험지(AI 가 notes 에 까닭을 적음, 그림은 원본과 같음)는 다시 묻지 않는다
      if (!worthReporting(m, a.notes, shape)) continue;
      advice.push(degreeMismatchText(m));
      adviceNotes.push(`그림: ${degreeMismatchNote(m)}`);
    }
    if (shape && shape.worst > SHAPE_DEVIATION_LIMIT && (pageUpright || Math.abs(shape.rotation) <= 45)) {
      advice.push(shapeDeviationText(shape));
      adviceNotes.push(`그림: ${shapeDeviationNote(shape)}`);
    }
  }
  return {
    ...base,
    commands: spec,
    rawCommands: check.spec ? undefined : a.commands,
    anchors,
    contentBox,
    unsure: a.unsure,
    notes: a.notes,
    errors: check.errors,
    ...(advice.length ? { advice, adviceNotes } : {}),
    ...(fixes.length ? { fixes } : {}),
    warnings,
  };
}

function clampBox(b: Region, image: { width: number; height: number }): Region | undefined {
  const x0 = Math.max(0, Math.min(image.width, b.x));
  const y0 = Math.max(0, Math.min(image.height, b.y));
  const x1 = Math.max(0, Math.min(image.width, b.x + b.w));
  const y1 = Math.max(0, Math.min(image.height, b.y + b.h));
  return x1 - x0 > 1 && y1 - y0 > 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}
