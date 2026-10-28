// 검증용 예시 A~F (작업지시서 8번).
// anchors: 원본 겹쳐 보기에 쓰는 기준점. figure 는 그림 속 점(이름이나 좌표),
// px 는 원본 사진 속 위치. 사진 크기(imageSize)가 다르면 비율로 맞춘다.
// 사진 속 위치는 대략값이라, 겹쳐 보기 화면에서 다시 찍어 고칠 수 있다.

import type { FigureSpec, PointRef } from "./types";

export type Anchor = { name: string; figure: PointRef; px: [number, number] };

export type Example = {
  key: string;
  title: string;
  note: string;
  image: string; // samples 폴더 파일 이름
  imageSize: [number, number]; // 아래 px 값을 잡을 때 기준으로 삼은 사진 크기
  anchors: Anchor[];
  printWidthMm: number; // 시험지에 들어갈 가로 크기
  spec: FigureSpec;
};

const EXAM = "exam_p1.jpg";
const EXAM_SIZE: [number, number] = [1126, 2000];

export const EXAMPLES: Example[] = [
  {
    key: "A",
    title: "A. 1번 이등변삼각형과 점 D",
    note: "원본은 꼭지각이 38°보다 조금 넓게 그려져 있어서, DC 가 살짝 어긋나는 것이 정상입니다.",
    image: EXAM,
    imageSize: EXAM_SIZE,
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [303, 897] },
      { name: "꼭짓점 B", figure: "B", px: [217, 1133] },
      { name: "꼭짓점 C", figure: "C", px: [392, 1133] },
    ],
    printWidthMm: 41,
    spec: {
      base: 11,
      points: [
        { id: "B", at: [0, 0] },
        { id: "C", at: [11, 0] },
        { id: "A", isoApex: { base: ["B", "C"], angle: 38 } },
        { id: "D", circleLine: { center: "C", through: "B", line: ["A", "B"], other: "B" } },
      ],
      elements: [
        { type: "segment", points: ["A", "B"] },
        { type: "segment", points: ["A", "C"] },
        { type: "segment", points: ["B", "C"] },
        { type: "segment", points: ["D", "C"] },
        { type: "label", at: "A", text: "A", dir: "N" },
        { type: "label", at: "B", text: "B", dir: "SW" },
        { type: "label", at: "C", text: "C", dir: "E" },
        { type: "label", at: "D", text: "D", dir: "W" },
        { type: "label", at: [5.5, 15.973 - 15.973 * 0.29], text: "38°", size: 0.85 },
      ],
    },
  },
  {
    key: "B",
    title: "B. 2번 두 이등분선의 교점 D",
    note: "E 는 끌어서 옮길 수 있습니다. 원본과 거의 그대로 겹쳐야 합니다.",
    image: EXAM,
    imageSize: EXAM_SIZE,
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [795, 425] },
      { name: "꼭짓점 B", figure: "B", px: [721, 583] },
      { name: "꼭짓점 C", figure: "C", px: [861, 583] },
      { name: "점 D", figure: "D", px: [970, 424] },
    ],
    printWidthMm: 50,
    spec: {
      base: 9.5,
      points: [
        { id: "B", at: [0, 0] },
        { id: "C", at: [9.5, 0] },
        { id: "A", isoApex: { base: ["B", "C"], angle: 56 } },
        { id: "E", glider: { line: ["B", "C"], from: "C", dist: 3.8 } },
        { id: "D", intersect: [{ bisector: ["A", "B", "C"] }, { bisector: ["A", "C", "E"] }] },
      ],
      elements: [
        { type: "segment", points: ["B", "E"], extendEnd: 1.73 },
        { type: "segment", points: ["A", "B"] },
        { type: "segment", points: ["A", "C"] },
        { type: "segment", points: ["B", "D"] },
        { type: "segment", points: ["C", "D"] },
        { type: "angle", points: ["C", "B", "D"], symbol: "dot", radius: 1.25 },
        { type: "angle", points: ["D", "B", "A"], symbol: "dot", radius: 1.25 },
        { type: "angle", points: ["E", "C", "D"], symbol: "cross", radius: 1.0 },
        { type: "angle", points: ["D", "C", "A"], symbol: "cross", radius: 1.0 },
        { type: "angle", points: ["B", "D", "C"], radius: 1.1 },
        { type: "dot", at: "E", size: 1.3 },
        { type: "label", at: [4.75, 8.933 - 1.75], text: "56°", size: 0.8 },
        { type: "label", at: "A", text: "A", dir: "N" },
        { type: "label", at: "B", text: "B", dir: "W" },
        { type: "label", at: "C", text: "C", dir: "S" },
        { type: "label", at: "D", text: "D", dir: "NE" },
        { type: "label", at: "E", text: "E", dir: "S" },
      ],
    },
  },
  {
    key: "C",
    title: "C. 3번 삼각형 ABE 와 수선 AC",
    note: "원본은 CE 가 조금 길게 그려져 있어서 E 쪽이 살짝 어긋나는 것이 정상입니다.",
    image: EXAM,
    imageSize: EXAM_SIZE,
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [972, 1052] },
      { name: "꼭짓점 B", figure: "B", px: [706, 1228] },
      { name: "꼭짓점 C", figure: "C", px: [978, 1228] },
      { name: "점 D", figure: "D", px: [843, 1140] },
    ],
    printWidthMm: 80,
    spec: {
      base: 11,
      points: [
        { id: "C", at: [0, 0] },
        { id: "A", at: [0, 9.4] },
        { id: "E", at: [7.05, 0] },
        { id: "B", at: [-16.281, 0] },
        { id: "D", intersect: [{ through: ["A", "B"] }, { through: ["C"], dirOf: ["C", "B"], turn: -30 }] },
      ],
      elements: [
        { type: "segment", points: ["B", "E"], extendEnd: 0.9 },
        { type: "segment", points: ["A", "B"] },
        { type: "segment", points: ["A", "E"] },
        { type: "segment", points: ["A", "C"] },
        { type: "segment", points: ["D", "C"] },
        { type: "rightAngle", points: ["E", "C", "A"], size: 0.75 },
        { type: "angle", points: ["C", "B", "A"], radius: 2.0, label: "30°", labelDist: 3.6 },
        { type: "angle", points: ["A", "D", "C"], radius: 1.1, label: "60°", labelDist: 2.3 },
        { type: "dimension", points: ["B", "D"], bulge: 0.12, label: "x", italic: true, gapStart: 0.9, gapEnd: 0.9 },
        { type: "dimension", points: ["A", "C"], bulge: 0.13, label: "8", gapStart: 0.9, gapEnd: 1.2 },
        { type: "dimension", points: ["A", "E"], bulge: 0.1, label: "10", gapStart: 0.9, gapEnd: 0.9 },
        { type: "dimension", points: ["C", "E"], bulge: -0.1, label: "6", gapStart: 0.9, gapEnd: 0.9 },
        { type: "label", at: "A", text: "A", dir: "N" },
        { type: "label", at: "B", text: "B", dir: "W" },
        { type: "label", at: "C", text: "C", dir: "S" },
        { type: "label", at: "D", text: "D", dir: 115 },
        { type: "label", at: "E", text: "E", dir: "SE" },
      ],
    },
  },
  {
    key: "D",
    title: "D. 쌓기나무 11개 (등각 그림)",
    note: "앞에서 본 모양 층수는 왼쪽부터 1, 1, 3, 1 / 옆에서 본 모양은 앞쪽부터 1, 1, 2, 3 이 되어야 합니다.",
    image: "cubes_problem4.png",
    imageSize: [651, 564],
    anchors: [
      { name: "'위' 동그라미 가운데", figure: [3.38, 6.97], px: [432, 100] },
      { name: "'앞' 동그라미 가운데", figure: [-1.18, -1.64], px: [343, 268] },
      { name: "'옆' 동그라미 가운데", figure: [7.54, -1.49], px: [513, 265] },
      { name: "'위' 격자 왼쪽 위 모서리", figure: [-12.6, -4.82], px: [120, 330] },
      { name: "'옆' 격자 오른쪽 아래 모서리", figure: [3.03 + 5 * 1.18, -4.82 - 5 * 1.18], px: [540, 445] },
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
        { type: "badge", at: [3.38, 6.97], text: "위", fill: "#CFE6A3", stroke: "#8DB55A", radius: 0.82 },
        { type: "arrow", from: [3.38, 6.05], to: [3.38, 4.67], width: 0.6 },
        { type: "badge", at: [-1.18, -1.64], text: "앞", fill: "#F7E58F", stroke: "#C9B34D", radius: 0.82 },
        { type: "arrow", from: [-0.2, -1.13], to: [0.97, -0.46], width: 0.6 },
        { type: "badge", at: [7.54, -1.49], text: "옆", fill: "#F5C6D0", stroke: "#C98798", radius: 0.82 },
        { type: "arrow", from: [6.62, -1.08], to: [5.33, -0.46], width: 0.6 },
        { type: "badge", at: [-9.69, -3.54], text: "위", fill: "#CFE6A3", stroke: "#8DB55A", radius: 0.82 },
        { type: "badge", at: [-1.08, -3.54], text: "앞", fill: "#F7E58F", stroke: "#C9B34D", radius: 0.82 },
        { type: "badge", at: [5.59, -3.54], text: "옆", fill: "#F5C6D0", stroke: "#C98798", radius: 0.82 },
        { type: "grid", at: [-12.6, -4.82], rows: 5, cols: 5, cell: 1.18, color: "#5B8BD6" },
        { type: "grid", at: [-3.59, -4.82], rows: 5, cols: 5, cell: 1.18, color: "#5B8BD6" },
        { type: "grid", at: [3.03, -4.82], rows: 5, cols: 5, cell: 1.18, color: "#5B8BD6" },
        { type: "badge", at: [-5.69, -9.03], text: "옆", fill: "#9C9C9C", stroke: "#6E6E6E", radius: 0.82 },
        { type: "badge", at: [-9.64, -13.38], text: "앞", fill: "#9C9C9C", stroke: "#6E6E6E", radius: 0.82 },
      ],
    },
  },
  {
    key: "E",
    title: "E. 쌓기나무 네 모양 (사선 그림)",
    note: "개수는 왼쪽 위부터 9, 9, 9, 10 입니다.",
    image: "cubes_worksheet.png",
    imageSize: [398, 563],
    anchors: [
      { name: "왼쪽 위 모양 앞줄 왼쪽 아래 모서리", figure: [0, 0], px: [85, 270] },
      { name: "오른쪽 위 모양 맨 오른쪽 아래 모서리", figure: [7.07 + 4, 0], px: [312, 270] },
      { name: "왼쪽 아래 모양 앞줄 왼쪽 아래 모서리", figure: [-0.73, -7.32], px: [70, 420] },
      { name: "오른쪽 아래 모양 앞줄 오른쪽 아래 모서리", figure: [7.41 + 3, -7.32], px: [299, 420] },
    ],
    printWidthMm: 110,
    spec: {
      base: 4,
      elements: [
        ...([
          { origin: [0, 0], heights: [[2, 0, 0], [3, 3, 1]] },
          { origin: [7.07, 0], heights: [[0, 0, 2, 1], [1, 1, 3, 1]] },
          { origin: [-0.73, -7.32], heights: [[0, 1, 0, 1, 0], [1, 2, 1, 2, 1]] },
          { origin: [7.41, -7.32], heights: [[1, 1, 1], [3, 3, 1]] },
        ] as { origin: [number, number]; heights: number[][] }[]).map((s) => ({
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
    imageSize: [560, 330],
    anchors: [
      { name: "꼭짓점 A", figure: "A", px: [113, 101] },
      { name: "꼭짓점 D", figure: "D", px: [372, 101] },
      { name: "꼭짓점 B", figure: "B", px: [113, 231] },
      { name: "꼭짓점 C", figure: "C", px: [372, 231] },
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
        { type: "dimension", points: ["A", "D"], bulge: 0.06, shape: "ellipse", dotted: true, color: "#8A8A8A", label: "12 cm", labelSize: 0.62, gapStart: 0.5, gapEnd: 0.5 },
        { type: "dimension", points: ["A", "B"], bulge: -0.11, shape: "ellipse", dotted: true, color: "#8A8A8A", label: "6 cm", labelSize: 0.62, labelPlace: "outside", gapStart: 0.5, gapEnd: 0.5 },
        { type: "label", at: "A", text: "A", dir: "NW", size: 0.68 },
        { type: "label", at: "B", text: "B", dir: "SW", size: 0.68 },
        { type: "label", at: "C", text: "C", dir: "SE", size: 0.68 },
        { type: "label", at: "D", text: "D", dir: "NE", size: 0.68 },
        { type: "label", at: "P", text: "P", dir: "S", size: 0.68 },
      ],
    },
  },
];
