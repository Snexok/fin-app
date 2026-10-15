// Проверка аудио по сигнатуре файла (MIME от клиента не доверяем).
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export function sniffAudio(b: Uint8Array): { ext: string; mime: string } | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (b.length < 12) return null;
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { ext: "webm", mime: "audio/webm" };
  if (ascii(0, "OggS")) return { ext: "ogg", mime: "audio/ogg" };
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return { ext: "wav", mime: "audio/wav" };
  if (ascii(4, "ftyp")) return { ext: "m4a", mime: "audio/mp4" };
  if (ascii(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: "mp3", mime: "audio/mpeg" };
  return null;
}
