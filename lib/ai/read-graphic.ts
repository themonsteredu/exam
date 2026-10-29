import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { addUsage, assistantTurn, callClaude, extractJson, modelFor, ReadError, type Usage, type Effort } from "./claude";
import { checkGraphic } from "@/lib/graphic/schema";
import type { FigureContext, FigureReading } from "./read-figure";
import type { ImageInput } from "./read-page";
import { piecesToText } from "./prompts";

export const GRAPHIC_SYSTEM = `너는 시험지의 지도·표·그래프·안내도·삽화를 원본과 같은 구성의 편집 가능한 자료로 재작성한다. 손글씨/답 표시/낙서는 제외한다. 문제를 풀거나 보이지 않는 글자, 사물, 도로 연결을 지어내지 않는다. 불명확한 사항은 unsure에 적는다.
답은 {"graphic": 아래 명령, "unsure": [확인이 필요한 내용], "notes": "짧은 설명"} JSON 하나다.
graphic={"kind":"map|table|chart|illustration|photo", "width":1000, "height":원본종횡비에맞는수,
"paths":[{"points":[[x,y],...],"closed":false,"stroke":"#000000","fill":"none","width":2,"dash":false}],
"ellipses":[{"cx":100,"cy":100,"rx":10,"ry":10,"stroke":"#000000","fill":"none","width":2}],
"texts":[{"x":0,"y":0,"w":100,"h":30,"text":"원본 글자","size":20,"align":"left|center|right","direction":"horizontal|vertical"}],
"tables":[{"x":0,"y":0,"w":1000,"h":500,"rows":2,"cols":2,"col_widths":[1,1],"row_heights":[1,1],"size":20,"cells":[{"row":0,"col":0,"row_span":1,"col_span":1,"text":"내용"}]}],
"critical_labels":["문제 풀이에 필요한 모든 지명/이름/숫자/단위/위치 표식의 원문"]}
좌표는 왼쪽 위 (0,0), 오른쪽 x, 아래 y다. 모든 도형과 글자는 0..width,0..height 안에 둔다. 배열은 없으면 []. SVG·HTML·스크립트는 쓰지 않는다. paths는 직선 또는 충분히 촘촘한 꼭짓점으로 곡선을 표현한다. strokes와 fill은 #RRGGBB 또는 none이다. 선, 건물, 사물, 글자를 분리한다.
지도: 도로 연결과 교차점, 건물 윤곽, 지명과 위치 표식을 원본 위치에 유지한다. 꼭 필요한 도로를 간략화하거나 표식 위치를 옮기지 않는다. 같은 사물의 개수/방향/배치가 문제의 단서라면 전부 유지한다.
표: tables로 행·열·병합을 정확히 기록한다. 행열 크기는 상대 비율이다. cells는 0부터 시작하며 병합 칸의 원점 하나에만 글을 넣는다. 빈 칸도 유지한다. 표 내용은 paths나 하나의 text로 대신하지 않는다.
사진: 실제 촬영 사진은 kind=photo, 모든 그리기 배열과 critical_labels=[]로 한다. 사진의 대상을 비슷한 삽화로 바꾸지 않는다.
글자: 원본의 읽을 수 있는 인쇄 표기는 모두 넣는다. 같은 글자를 두 번 넣지 않는다. 세로 지명은 direction=vertical. 좁은 곳에 긴 글자를 강제로 넣지 않는다. 글자와 도로·표식을 겹치지 않게 원본의 빈 곳에 둔다.
확인할 수 없는 내용이나 생략한 내용은 반드시 unsure에 적는다. 전체 재작성의 정확성이 자동으로 검증됐다고 주장하지 않는다.`;

export function judgeGraphic(text: string, attempt = 1): FigureReading {
  const base: FigureReading = { anchors: [], unsure: [], notes: "", errors: [], warnings: [], attempts: attempt };
  let raw: any;
  try { raw = extractJson(text); } catch (e) { return { ...base, errors: [String(e)] }; }
  const check = checkGraphic(raw?.graphic);
  return { ...base, graphic: check.spec, errors: check.errors, warnings: check.warnings,
    unsure: Array.isArray(raw?.unsure) ? raw.unsure.filter((v: unknown) => typeof v === "string").slice(0, 50) : [],
    notes: typeof raw?.notes === "string" ? raw.notes.slice(0, 2000) : "" };
}

export async function readGraphic(image: ImageInput, item: FigureContext, o: { model?: string; effort?: Effort; apiKey?: string; signal?: AbortSignal; deadline?: number } = {}): Promise<{ figure: FigureReading; usage: Usage }> {
  const messages: BetaMessageParam[] = [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
    { type: "text", text: `${item.no}번 자료. 사진 ${image.width}×${image.height}px. 문제: ${piecesToText(item.stem)}\n선택지: ${item.choices.map(piecesToText).join(" / ")}\n보기: ${item.bogi.map(piecesToText).join(" / ")}\n이 문제의 자료를 재작성해 주세요.` },
  ] }];
  let usage: Usage | undefined, result: FigureReading | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let call;
    try { call = await callClaude({ system: GRAPHIC_SYSTEM, messages, model: modelFor("figure", o.model), apiKey: o.apiKey,
      effort: o.effort ?? "high", maxTokens: 32000, signal: o.signal, deadline: o.deadline }); }
    catch (e) { if (e instanceof ReadError && usage) e.usage = e.usage ? addUsage(usage, e.usage) : usage; throw e; }
    usage = addUsage(usage, call.usage);
    result = judgeGraphic(call.text, attempt);
    if (!result.errors.length || attempt === 2 || (o.deadline && o.deadline - Date.now() < 120000)) break;
    messages.push(assistantTurn(call.message), { role: "user", content: `다음 오류를 고쳐 전체 JSON을 다시 주세요. 내용을 지어내지 마세요.\n${result.errors.join("\n")}` });
  }
  return { figure: result!, usage: usage! };
}
