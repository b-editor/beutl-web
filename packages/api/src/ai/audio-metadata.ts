import { parseBuffer } from "music-metadata";

export type ParsedAudio = {
  bytes: ArrayBuffer;
  durationSeconds: number;
};

export async function parseAudio(file: File): Promise<ParsedAudio> {
  const bytes = await file.arrayBuffer();
  const metadata = await parseBuffer(
    new Uint8Array(bytes),
    {
      size: file.size,
      mimeType: file.type || undefined,
      path: file.name,
    },
    {
      duration: true,
      skipCovers: true,
    },
  );
  const durationSeconds = metadata.format.duration;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error("The audio duration could not be determined");
  }

  return { bytes, durationSeconds };
}
