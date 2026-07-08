// 拡張子からの MIME 推定と、インライン表示可否の判定。
// エアギャップ前提でライブラリを使わず最小マップで判定する。Node/DOM 双方から参照可能。

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
};

export function mimeFromFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

// インラインサムネイル対象(§6.5: svg はサニタイズ困難のため対象外=ファイル扱い)。
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

export function isInlineImageMime(mime: string): boolean {
  return INLINE_IMAGE_MIMES.has(mime);
}
