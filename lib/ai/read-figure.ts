// 2차 읽기: 그림 하나(잘라서 키운 사진) + 문제 글 → 그림 명령.
// 받은 그림 명령은 바로 검사하고, 틀린 곳이 있으면 그 내용을 돌려보내 한 번 더 고쳐 받는다.
// 서버 전용 (Claude 를 부른다).

import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { checkFigureSpec } from "@/lib/figure/validate";
import type { FigureSpec, PointRef } from "@/lib/figure/types";
import { addUsage, assistantTurn, callClaude, extractJson, modelFor, ReadError, type Effort, type Usage } from "./claude";
import type { Piece, Region } from "./page-schema";
import { FIGURE_SYSTEM, figureRepairText, figureUserText, piecesToText } from "./prompts";
import type { ImageInput } from "./read-page";

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
  o: { model?: string; effort?: Effort; maxAttempts?: number; apiKey?: string; signal?: AbortSignal; deadline?: number } = {},
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
          }),
        },
      ],
    },
  ];
  let usage: Usage | undefined;
  let result: FigureReading | undefined;
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
      // 앞서 고쳐 받느라 쓴 토큰도 요금 기록에 넣게 붙여 보낸다
      if (err instanceof ReadError && usage) err.usage = err.usage ? addUsage(usage, err.usage) : usage;
      throw err;
    }
    usage = addUsage(usage, call.usage);
    result = judge(call.text, image, attempt);
    if (!result.errors.length || attempt === maxAttempts) break;
    // 고쳐 받을 시간이 모자라면 그대로 돌려준다 (서버 함수 시간 한도를 넘겨 이미 받은 답까지 잃지 않게)
    if (o.deadline && o.deadline - Date.now() < 120_000) break;
    messages.push(assistantTurn(call.message), { role: "user", content: figureRepairText(result.errors) });
  }
  return { figure: result!, usage: usage! };
}

/** AI 의 답을 읽고 검사한다 */
export function judge(text: string, image: { width: number; height: number }, attempt = 1): FigureReading {
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
  return {
    ...base,
    commands: check.spec,
    rawCommands: check.spec ? undefined : a.commands,
    anchors,
    contentBox,
    unsure: a.unsure,
    notes: a.notes,
    errors: check.errors,
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
