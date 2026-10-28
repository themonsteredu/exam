// 그림 명령 JSON 의 모양.
// AI 가 이 형식으로 그림을 적고, 엔진(engine.ts)이 JSXGraph 로 그린다.
// 좌표 단위는 그림마다 정한다(보통 밑변이 10 안팎).

export type XY = [number, number];
/** 점 이름 또는 좌표 */
export type PointRef = string | XY;

/** 직선을 정하는 방법 */
export type LineSpec =
  | { through: [PointRef, PointRef] } // 두 점을 지나는 직선
  | { through: [PointRef]; angle: number } // 한 점과 방향(도, x축에서 시계 반대 방향)
  | { through: [PointRef]; dirOf: [PointRef, PointRef]; turn?: number } // 한 점, 다른 선분 방향에서 turn 도 돌린 방향
  | { bisector: [PointRef, PointRef, PointRef] } // 각 (앞점, 꼭짓점, 뒷점) 의 이등분선. 바깥각은 연장선 위의 점을 쓴다
  | { perpendicular: { through: PointRef; to: [PointRef, PointRef] } };

/** 점 만들기 */
export type PointSpec = { id: string } & (
  | { at: XY } // 좌표로 찍기
  | { isoApex: { base: [PointRef, PointRef]; angle: number; side?: "left" | "right" } } // 이등변삼각형 꼭짓점 (꼭지각)
  | { polar: { from: PointRef; length: number; angle?: number; dirOf?: [PointRef, PointRef]; turn?: number } } // 한 점에서 길이와 방향
  | { intersect: [LineSpec, LineSpec] } // 두 직선의 교점
  | { circleLine: { center: PointRef; radius?: number; through?: PointRef; line: [PointRef, PointRef]; other?: PointRef; near?: PointRef } } // 원과 직선이 만나는 (다른 한) 점
  | { foot: { from: PointRef; to: [PointRef, PointRef] } } // 수선의 발
  | { midpoint: [PointRef, PointRef] } // 중점
  | { glider: { line: [PointRef, PointRef]; from: PointRef; dist: number; segment?: boolean } } // 선 위를 움직이는 자유점 (from 에서 line 방향으로 dist)
);

export type Dir = "N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW" | number;

/** 점 이름과 글자 */
export type LabelSpec = {
  type: "label";
  at: PointRef;
  text: string; // 적힌 그대로 그린다 (A_1, x^2 도 그대로). 첨자는 A₁, x² 처럼 글자로 쓴다
  dir?: Dir; // 점에서 어느 쪽에 둘지 (없으면 그 자리 가운데)
  offset?: number; // 점에서 떨어진 거리 (글자 크기 배수, 기본 0.75)
  size?: number; // 글자 크기 배수 (기본 1 = 밑변의 15%)
  italic?: boolean;
  font?: "serif" | "sans"; // serif: 점 이름, sans: 한글(에스코어드림)
  color?: string;
};

export type Stroke = {
  width?: number; // 본선 굵기 배수 (기본 1)
  color?: string;
  dash?: boolean; // 보조 점선
};

export type ElementSpec =
  | ({ type: "segment"; points: [PointRef, PointRef]; extendStart?: number; extendEnd?: number } & Stroke)
  | ({ type: "line"; points: [PointRef, PointRef]; ray?: boolean } & Stroke) // 직선, ray 면 반직선
  | ({ type: "polygon"; points: PointRef[]; fill?: string; border?: boolean } & Stroke)
  | ({ type: "circle"; center: PointRef; radius?: number; through?: PointRef; fill?: string } & Stroke)
  | ({ type: "arc"; center: PointRef; from: PointRef; to: PointRef; radius?: number } & Stroke) // 시계 반대 방향
  | ({
      type: "angle";
      points: [PointRef, PointRef, PointRef]; // 앞점, 꼭짓점, 뒷점
      radius?: number;
      count?: number; // 겹 수
      symbol?: "dot" | "cross"; // 똑같이 나뉜 각 표시
      label?: string;
      labelDist?: number; // 꼭짓점에서 글자까지 거리
      labelSize?: number;
    } & Stroke)
  | ({ type: "rightAngle"; points: [PointRef, PointRef, PointRef]; size?: number } & Stroke)
  | ({ type: "ticks"; points: [PointRef, PointRef]; count?: number; size?: number } & Stroke) // 같은 길이 표시
  | ({
      type: "dimension"; // 길이 표시 점선 호
      points: [PointRef, PointRef];
      bulge: number; // 볼록한 정도(두 점 거리에 대한 비율). + 는 앞점→뒷점 방향의 왼쪽
      shape?: "arc" | "ellipse";
      label?: string;
      italic?: boolean;
      labelSize?: number;
      gapStart?: number; // 끝점 쪽에서 비울 길이 (점 이름 자리)
      gapEnd?: number;
      dotted?: boolean; // 동그란 점선 (기본은 짧은 점선)
      labelPlace?: "on" | "outside"; // on: 호 위에 두고 그 자리 선을 비움, outside: 호 바깥에 붙여 둠
      color?: string;
      width?: number;
    })
  | LabelSpec
  | { type: "dot"; at: PointRef; size?: number; color?: string }
  | {
      type: "axes";
      x: [number, number];
      y: [number, number];
      ticks?: number; // 눈금 간격 (0 이면 없음)
      tickLabels?: boolean;
      origin?: boolean; // O 표시
    }
  | ({ type: "function"; expr: string; domain: [number, number] } & Stroke)
  | {
      type: "cubes";
      heights: number[][]; // heights[줄 r][칸 c], 0번 줄이 앞줄
      mode: "oblique" | "iso";
      origin?: XY; // 앞줄 왼쪽 칸 바닥의 기준점
      size?: number; // 쌓기나무 한 변
      depth?: number; // 사선 그림에서 한 줄 뒤로 갈 때 옮기는 비율 (기본 0.45)
      colors?: { top?: string; front?: string; side?: string; edge?: string };
    }
  | { type: "grid"; at: XY; rows: number; cols: number; cell: number; dash?: boolean; color?: string } // at: 왼쪽 위
  | { type: "badge"; at: XY; text: string; fill?: string; stroke?: string; radius?: number; textColor?: string } // 동그라미 라벨
  | ({ type: "arrow"; from: PointRef; to: PointRef } & Stroke);

export type FigureSpec = {
  /** 밑변 길이. 선 굵기(1%)와 글자 크기(15%)의 기준 */
  base: number;
  /** 보이는 범위 [왼쪽, 위, 오른쪽, 아래]. 없으면 점과 요소에서 자동 계산 */
  bbox?: [number, number, number, number];
  points?: PointSpec[];
  elements: ElementSpec[];
  /** 점 이름 글꼴 크기 배수 등 전체 조정값 */
  style?: { lineScale?: number; labelScale?: number };
};
