// 검증용 예시 A~F (작업지시서 8번).
// A~C 의 그림 명령은 시험지 데이터(data/exam_p1_manual.json)의 1~3번 문제에서 그대로 가져온다.
// anchors: 원본 겹쳐 보기에 쓰는 기준점. figure 는 그림 속 점(이름이나 좌표),
// px 는 원본 사진(samples 폴더) 속 위치. 사진 크기가 imageSize 와 다르면 비율로 맞춘다.

import examP1 from "@/data/exam_p1_manual.json";
import type { FigureSpec, PointRef } from "./types";

export type Anchor = { name: string; figure: PointRef; px: [number, number] };

export type Example = {
  key: string;
  title: string;
  note: string;
  image: string; // samples 폴더 파일 이름
  imageSize: [number, number]; // px 값을 잰 사진 크기
  anchors: Anchor[];
  printWidthMm: number; // 시험지에 들어갈 가로 크기
  spec: FigureSpec;
};

type ExamFigure = { width_mm: number; commands: unknown };
type ExamItem = { no: number; figure?: ExamFigure };

function examFigure(no: number): { spec: FigureSpec; widthMm: number } {
  const items = (examP1 as unknown as { sections: { items: ExamItem[] }[] }).sections.flatMap((s) => s.items);
  const fig = items.find((it) => it.no === no)?.figure;
  if (!fig) throw new Error(`시험지 데이터에 ${no}번 그림이 없습니다`);
  return { spec: fig.commands as FigureSpec, widthMm: fig.width_mm };
}

const EXAM = "exam_p1.jpg";
const EXAM_SIZE: [number, number] = [1126, 2000];
const P1 = examFigure(1);
const P2 = examFigure(2);
const P3 = examFigure(3);

// D: 등각 그림 쌓기나무. 단위 1 = 쌓기나무 한 변(사진에서 22.6px), 원점 = 앞줄 왼쪽 칸 바닥 꼭짓점(361.4, 224.6)
const D_GRID_TOP = -6.08;
const D_CELL = 1.018;

export const EXAMPLES: Example[] = [
  {
    key: "A",
    title: "A. 1번 이등변삼각형과 점 D",
    note: "원본은 꼭지각이 38°보다 조금 넓게 그려져 있어서, DC 가 살짝 어긋나는 것이 정상입니다.",
    image: EXAM,
    imageSize: EXAM_SIZE,
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [304, 899] },
      { name: "꼭짓점 B", figure: "B", px: [213, 1133] },
      { name: "꼭짓점 C", figure: "C", px: [394, 1130] },
    ],
    printWidthMm: P1.widthMm,
    spec: P1.spec,
  },
  {
    key: "B",
    title: "B. 2번 두 이등분선의 교점 D",
    note: "E 는 끌어서 옮길 수 있습니다. 원본과 거의 그대로 겹쳐야 합니다.",
    image: EXAM,
    imageSize: EXAM_SIZE,
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [795, 433] },
      { name: "꼭짓점 B", figure: "B", px: [722, 583] },
      { name: "꼭짓점 C", figure: "C", px: [876, 581] },
      { name: "점 D", figure: "D", px: [969, 432] },
    ],
    printWidthMm: P2.widthMm,
    spec: P2.spec,
  },
  {
    key: "C",
    title: "C. 3번 삼각형 ABE 와 수선 AC",
    note: "원본은 CE 가 조금 길게 그려져 있어서 E 쪽이 살짝 어긋나는 것이 정상입니다.",
    image: EXAM,
    imageSize: EXAM_SIZE,
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [971, 1070] },
      { name: "꼭짓점 B", figure: "B", px: [700, 1224] },
      { name: "꼭짓점 C", figure: "C", px: [978, 1220] },
      { name: "점 D", figure: "D", px: [841, 1144] },
    ],
    printWidthMm: P3.widthMm,
    spec: P3.spec,
  },
  {
    key: "D",
    title: "D. 쌓기나무 11개 (등각 그림)",
    note: "앞에서 본 모양 층수는 왼쪽부터 1, 1, 3, 1 / 옆에서 본 모양은 앞쪽부터 1, 1, 2, 3 이 되어야 합니다.",
    image: "cubes_problem4.png",
    imageSize: [651, 564],
    anchors: [
      { name: "'위' 동그라미 가운데", figure: [3.21, 5.34], px: [434, 104] },
      { name: "'앞' 동그라미 가운데", figure: [-0.46, -1.74], px: [351, 264] },
      { name: "'옆' 동그라미 가운데", figure: [6.75, -1.88], px: [514, 267] },
      { name: "'위' 격자 왼쪽 위 모서리", figure: [-10.68, D_GRID_TOP], px: [120, 362] },
      { name: "'옆' 격자 오른쪽 아래 모서리", figure: [2.68 + 5 * D_CELL, D_GRID_TOP - 5 * D_CELL], px: [539, 475] },
    ],
    printWidthMm: 110,
    spec: {
      base: 7,
      elements: [
        {
          type: "cubes",
          mode: "iso",
          // heights[줄 r][칸 c]
          heights: [
            [0, 1, 1, 0],
            [1, 1, 1, 0],
            [0, 0, 2, 0],
            [0, 0, 3, 1],
          ],
          origin: [0, 0],
          size: 1,
          colors: { top: "#EAD6AE", front: "#DFC69A", side: "#C9AC82", edge: "#4B3E31" },
        },
        { type: "badge", at: [3.21, 5.34], text: "위", fill: "#CFE6A3", stroke: "#8DB55A", radius: 0.86 },
        { type: "arrow", from: [3.21, 4.42], to: [3.21, 3.63], width: 0.6 },
        { type: "badge", at: [-0.46, -1.74], text: "앞", fill: "#F7E58F", stroke: "#C9B34D", radius: 0.86 },
        { type: "arrow", from: [0.39, -1.23], to: [1.15, -0.97], width: 0.6 },
        { type: "badge", at: [6.75, -1.88], text: "옆", fill: "#F5C6D0", stroke: "#C98798", radius: 0.86 },
        { type: "arrow", from: [5.86, -1.5], to: [5.15, -1.19], width: 0.6 },
        { type: "badge", at: [-8.38, -4.97], text: "위", fill: "#CFE6A3", stroke: "#8DB55A", radius: 0.69 },
        { type: "badge", at: [-0.5, -4.97], text: "앞", fill: "#F7E58F", stroke: "#C9B34D", radius: 0.69 },
        { type: "badge", at: [5.16, -4.97], text: "옆", fill: "#F5C6D0", stroke: "#C98798", radius: 0.69 },
        { type: "grid", at: [-10.68, D_GRID_TOP], rows: 5, cols: 5, cell: D_CELL, color: "#5B8BD6" },
        { type: "grid", at: [-2.94, D_GRID_TOP], rows: 5, cols: 5, cell: D_CELL, color: "#5B8BD6" },
        { type: "grid", at: [2.68, D_GRID_TOP], rows: 5, cols: 5, cell: D_CELL, color: "#5B8BD6" },
        { type: "badge", at: [-4.62, -8.51], text: "옆", fill: "#9C9C9C", stroke: "#6E6E6E", radius: 0.69 },
        { type: "badge", at: [-8.25, -12.05], text: "앞", fill: "#9C9C9C", stroke: "#6E6E6E", radius: 0.69 },
      ],
    },
  },
  {
    key: "E",
    title: "E. 쌓기나무 네 모양 (사선 그림)",
    note: "개수는 왼쪽 위부터 9, 9, 9, 10 입니다.",
    image: "cubes_worksheet.png",
    imageSize: [391, 553],
    anchors: [
      { name: "왼쪽 위 모양 앞줄 왼쪽 아래 모서리", figure: [0, 0], px: [86, 270] },
      { name: "오른쪽 위 모양 앞줄 쌓기나무 왼쪽 아래 모서리", figure: [6.5 + 2, 0], px: [262.5, 270] },
      { name: "왼쪽 아래 모양 앞줄 첫 쌓기나무 왼쪽 아래 모서리", figure: [-1.17 + 1, -7.67], px: [82.5, 431] },
      { name: "오른쪽 아래 모양 앞줄 왼쪽 아래 모서리", figure: [7.21, -7.67], px: [236.5, 431] },
    ],
    printWidthMm: 110,
    spec: {
      base: 4,
      elements: [
        ...(
          [
            { origin: [0, 0], heights: [[2, 0, 0], [3, 3, 1]] },
            { origin: [6.5, 0], heights: [[0, 0, 2, 1], [1, 1, 3, 1]] },
            { origin: [-1.17, -7.67], heights: [[0, 1, 0, 1, 0], [1, 2, 1, 2, 1]] },
            { origin: [7.21, -7.67], heights: [[1, 1, 1], [3, 3, 1]] },
          ] as { origin: [number, number]; heights: number[][] }[]
        ).map((s) => ({
          type: "cubes" as const,
          mode: "oblique" as const,
          origin: s.origin,
          heights: s.heights,
          size: 1,
          depth: 0.45,
          colors: { top: "#E2BE6C", front: "#C88F39", side: "#9E5E1E", edge: "#6E4518" },
        })),
      ],
    },
  },
  {
    key: "F",
    title: "F. 직사각형 ABCD 와 점 P",
    note: "P 는 BC 위에서 끌어서 옮길 수 있습니다.",
    image: "rect_p.jpg",
    imageSize: [560, 357],
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [114, 104] },
      { name: "꼭짓점 D", figure: "D", px: [370, 103] },
      { name: "꼭짓점 B", figure: "B", px: [113, 231] },
      { name: "꼭짓점 C", figure: "C", px: [370, 231] },
    ],
    printWidthMm: 55,
    spec: {
      base: 12,
      points: [
        { id: "B", at: [0, 0] },
        { id: "C", at: [12, 0] },
        { id: "D", at: [12, 6] },
        { id: "A", at: [0, 6] },
        { id: "P", glider: { line: ["B", "C"], from: "B", dist: 7.2, segment: true } },
      ],
      elements: [
        { type: "polygon", points: ["A", "B", "P"], fill: "#E8EBC3", border: false },
        { type: "segment", points: ["A", "B"] },
        { type: "segment", points: ["B", "C"] },
        { type: "segment", points: ["C", "D"] },
        { type: "segment", points: ["D", "A"] },
        { type: "segment", points: ["A", "P"] },
        { type: "dimension", points: ["A", "D"], bulge: 0.12, shape: "ellipse", dotted: true, color: "#8A8A8A", label: "12 cm", labelSize: 0.62, gapStart: 0.5, gapEnd: 0.5 },
        { type: "dimension", points: ["A", "B"], bulge: -0.2, shape: "ellipse", dotted: true, color: "#8A8A8A", label: "6 cm", labelSize: 0.62, gapStart: 0.5, gapEnd: 0.5 },
        { type: "label", at: "A", text: "A", dir: "NW", size: 0.68 },
        { type: "label", at: "B", text: "B", dir: "SW", size: 0.68 },
        { type: "label", at: "C", text: "C", dir: "SE", size: 0.68 },
        { type: "label", at: "D", text: "D", dir: "NE", size: 0.68 },
        { type: "label", at: "P", text: "P", dir: "S", size: 0.68 },
      ],
    },
  },
];
