// 사진 크기 계산: AI 에게 보낼 크기, 그림 자르기, 사진 머리에서 크기 읽기.
// 브라우저와 서버, 스크립트가 같이 쓴다 (사진을 실제로 줄이고 자르는 일은 각자 한다).

import type { Region } from "./page-schema";

/** AI 가 받는 사진의 긴 변 상한 (이보다 크면 AI 쪽에서 줄여 좌표가 어긋난다) */
export const MAX_EDGE = 2576;
/** AI 가 받는 사진의 픽셀 수 상한 (3.75MP 보다 조금 작게) */
export const MAX_PIXELS = 3_700_000;

export type Size = { width: number; height: number };

/** 쪽 사진을 AI 에게 보낼 크기. 줄이기만 하고 키우지는 않는다. scale = 보낸 크기 / 원본 크기 */
export function fitForClaude(width: number, height: number): Size & { scale: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  // 내림: 반올림하면 상한을 몇 픽셀 넘을 수 있다
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

/**
 * 쪽 읽기에서 받은 그림 사각형(보낸 사진 픽셀)을 원본 사진에서 자를 사각형으로 바꾼다.
 * AI 가 잡은 사각형이 조금 작을 수 있어 둘레에 여백을 붙인다.
 */
export function figureCropRect(box: Region, pageScale: number, original: Size, marginRatio = 0.1, marginPx = 16): Region {
  const x = box.x / pageScale;
  const y = box.y / pageScale;
  const w = box.w / pageScale;
  const h = box.h / pageScale;
  const m = Math.max(marginPx, Math.max(w, h) * marginRatio);
  const x0 = Math.max(0, Math.floor(x - m));
  const y0 = Math.max(0, Math.floor(y - m));
  const x1 = Math.min(original.width, Math.ceil(x + w + m));
  const y1 = Math.min(original.height, Math.ceil(y + h + m));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** 잘라 낸 그림을 AI 에게 보낼 크기: 작은 글자도 보이게 긴 변을 1600px 쯤으로 (최대 4배까지 키움) */
export function figureSendSize(width: number, height: number): Size & { scale: number } {
  let scale = 1600 / Math.max(width, height);
  scale = Math.min(scale, 4, Math.sqrt(2_500_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** PNG·JPEG·WEBP·GIF 파일 머리에서 가로·세로를 읽는다. 모르는 모양이면 null */
export function imageSizeFromBytes(b: Uint8Array): (Size & { type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }) | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "image/png", width: u32(16), height: u32(20) };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: "image/gif", width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { type: "image/webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { type: "image/webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16(i + 2);
      // SOF 표시: 0xC0~0xCF 가운데 0xC4(허프만 표), 0xC8, 0xCC 는 아님
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "image/jpeg", height: u16(i + 5), width: u16(i + 7) };
      }
      i += 2 + length;
    }
  }
  return null;
}
