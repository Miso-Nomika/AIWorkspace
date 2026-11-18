// 채팅에 첨부하는 이미지 준비: 너무 크면 줄이고, 에이전트에 보낼 base64와 대화 기록용 작은 미리보기를 만든다.
// fitSize·정책 상수는 순수 함수 (node로 테스트 가능), prepareImage는 브라우저(WebView)에서만 동작한다.

/** 한 번에 첨부할 수 있는 최대 장수 (Rust의 MAX_IMAGES와 같게 유지) */
export const MAX_ATTACHMENTS = 5;
/** 모델이 활용하는 한계 근처로 긴 변을 줄인다 */
const MAX_EDGE = 1568;
const THUMB_EDGE = 120;
/** 이보다 큰 PNG는 JPEG로 바꿔 크기를 줄인다 */
const MAX_PNG_BYTES = 3 * 1024 * 1024;

export interface ImageAttachment {
  mediaType: string;
  /** base64 (data URL 머리말 없음) */
  data: string;
  /** 화면·대화 기록용 작은 미리보기 (data URL) */
  preview: string;
  name: string;
}

export function isImageFile(file: { type: string }): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(file.type);
}

/** 긴 변이 max를 넘으면 비율을 유지하며 줄인 크기 */
export function fitSize(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function draw(bitmap: ImageBitmap, edge: number): HTMLCanvasElement {
  const { width, height } = fitSize(bitmap.width, bitmap.height, edge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function dataUrlParts(url: string): { mediaType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!match) throw new Error("이미지를 변환하지 못했습니다.");
  return { mediaType: match[1], data: match[2] };
}

/** 이미지 파일을 첨부 가능한 형태로 바꾼다. 움직이는 GIF는 첫 장면만 쓴다. */
export async function prepareImage(file: File): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = draw(bitmap, MAX_EDGE);
    // 투명도가 있을 수 있는 형식은 PNG로 두되, 너무 크면 JPEG로
    let url = file.type === "image/jpeg" ? canvas.toDataURL("image/jpeg", 0.88) : canvas.toDataURL("image/png");
    if (url.startsWith("data:image/png") && url.length * 0.75 > MAX_PNG_BYTES) url = canvas.toDataURL("image/jpeg", 0.88);
    const { mediaType, data } = dataUrlParts(url);
    const preview = draw(bitmap, THUMB_EDGE).toDataURL("image/jpeg", 0.7);
    return { mediaType, data, preview, name: file.name || "붙여넣은 이미지" };
  } finally {
    bitmap.close();
  }
}
