// 1차 읽기: 시험지 한 쪽 사진 → 머리 표, 안내 상자, 문항, 그림 위치.
// 서버 전용 (설정에서 고른 AI를 부른다).

import { callAI, assistantTurn, type AITurn } from "./client";
import { addUsage, extractJson, modelFor, ReadError, type Effort, type Usage } from "./claude";
import { figureRegionKey, validFigureRegion } from "./image-geometry";
import { PageReadingS, pageReadingJsonSchema, type ItemReading, type PageReading } from "./page-schema";
import { PAGE_SYSTEM, pageUserText } from "./prompts";

export type ImageInput = {
  /** base64 글자 (data: 머리말 없이) */
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
};

export const PAGE_EFFORT: Effort = "medium";

type FigureIssue = { item: ItemReading; message: string };

function pageFigureIssues(reading: PageReading, image: ImageInput): FigureIssue[] {
  const issues: FigureIssue[] = [];
  for (const { items } of reading.sections) {
    for (const item of items) {
      const boxes = new Set<string>();
      for (const [index, box] of item.figures.entries()) {
        if (!validFigureRegion(box, image)) {
          issues.push({ item, message: `그림 ${index + 1}의 영역이 보낸 사진의 픽셀 범위와 맞지 않습니다.` });
          continue;
        }
        const coordinates = figureRegionKey(box);
        if (boxes.has(coordinates)) {
          issues.push({ item, message: `그림 ${index + 1}이 앞 그림과 같은 영역을 가리킵니다.` });
        }
        boxes.add(coordinates);
      }
      const emptyChoices = item.choices.filter((choice) => choice.every(({ text }) => !text.trim())).length;
      if (emptyChoices >= 2 && emptyChoices > boxes.size) {
        issues.push({
          item,
          message: `내용이 비어 있는 선택지 ${emptyChoices}개에 비해 읽은 그림 영역이 ${boxes.size}개입니다. 번호별로 인쇄된 글이나 그림을 확인해 주세요.`,
        });
      }
    }
  }
  return issues;
}

function notePageFigureIssues(reading: PageReading, issues: FigureIssue[]) {
  let figureReviewNeeded = issues.length > 0;
  for (const { item, message } of issues) {
    if (!item.unsure.includes(message)) item.unsure.push(message);
  }
  for (const { items } of reading.sections) {
    for (const item of items) {
      if (item.figures.length) continue;
      const stem = item.stem.filter((piece) => piece.kind === "t").map((piece) => piece.text).join(" ");
      if (/그림과\s*같이|(?:오른쪽|왼쪽|아래|위|다음|주어진)\s*그림/.test(stem)) {
        item.unsure.push("그림을 가리키는 문항인데 읽은 그림 영역이 없습니다. 원본을 확인해 주세요.");
        figureReviewNeeded = true;
      }
    }
  }
  return { reading, figureReviewNeeded };
}

export async function readPage(
  image: ImageInput,
  o: { page: number; total: number; before?: string; model?: string; effort?: Effort; apiKey?: string; signal?: AbortSignal; deadline?: number },
): Promise<{ reading: PageReading; figureReviewNeeded: boolean; usage: Usage; raw: string }> {
  const messages: AITurn[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: pageUserText({ width: image.width, height: image.height, page: o.page, total: o.total, before: o.before }) },
      ],
    },
  ];
  const model = modelFor("page", o.model);
  const jsonSchema = pageReadingJsonSchema();
  let usage: Usage | undefined;
  let issue = "";
  let best: { reading: PageReading; raw: string; issues: FigureIssue[] } | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let call;
    try {
      call = await callAI({
        system: PAGE_SYSTEM,
        model,
        apiKey: o.apiKey,
        messages,
        effort: o.effort ?? PAGE_EFFORT,
        maxTokens: 32000,
        // 구조화 출력: 답이 꼭 정해진 모양이 되게 한다 (API 가 이 모양을 받지 못하면 callAI 가 지시문 방식으로 한 번 다시 묻는다)
        jsonSchema,
        signal: o.signal,
        deadline: o.deadline,
      });
    } catch (err) {
      if (best && usage && !o.signal?.aborted) {
        if (err instanceof ReadError && err.usage) usage = addUsage(usage, err.usage);
        return { ...notePageFigureIssues(best.reading, best.issues), usage, raw: best.raw };
      }
      if (err instanceof ReadError && usage) err.usage = err.usage ? addUsage(usage, err.usage) : usage;
      throw err;
    }
    usage = addUsage(usage, call.usage);
    try {
      const parsed = PageReadingS.safeParse(extractJson(call.text));
      if (parsed.success) {
        const issues = pageFigureIssues(parsed.data, image);
        if (!issues.length) return { ...notePageFigureIssues(parsed.data, issues), usage, raw: call.text };
        if (!best || issues.length < best.issues.length) best = { reading: parsed.data, raw: call.text, issues };
        issue = issues.map(({ item, message }) => `${item.no_text || item.no}: ${message}`).join("\n").slice(0, 2000);
      } else {
        issue = parsed.error.message.slice(0, 2000);
      }
    } catch (err) {
      issue = err instanceof Error ? err.message : String(err);
    }
    if (attempt === 2 || o.signal?.aborted || (o.deadline && o.deadline - Date.now() < 120_000)) break;
    messages.push(assistantTurn(call.message), {
      role: "user",
      content: `답을 검사하니 다음 오류가 있습니다. 같은 사진에서 해당 문항의 글과 번호별 그림을 다시 확인하고 전체 JSON을 보내 주세요. 문항·선택지·그림을 빠뜨리지 말고 정해진 모양을 지켜 주세요. 설명이나 코드 블록 없이 JSON 하나만 답합니다.\n${issue}`,
    });
  }
  if (best && usage && !o.signal?.aborted) {
    return { ...notePageFigureIssues(best.reading, best.issues), usage, raw: best.raw };
  }
  const err = new ReadError("bad_answer", "AI 의 답이 정해진 모양과 달라 문항을 확인하지 못했습니다. 다시 시도해 주세요.", issue.slice(0, 500));
  err.usage = usage;
  throw err;
}

/** 다음 쪽을 읽을 때 알려 줄 앞 쪽의 끝 (이어지는 부분의 번호를 맞추려고) */
export function continuationHint(sectionTitle: string | undefined, lastNo: number | undefined): string | undefined {
  if (lastNo === undefined) return undefined;
  const title = sectionTitle ? `"${sectionTitle}" 부분의 ` : "";
  return `앞 쪽은 ${title}${lastNo}번 문항에서 끝났습니다.`;
}
