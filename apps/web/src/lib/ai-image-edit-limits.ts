export function rawImageEditSourceExceedsLimit(
  task: string,
  fileSize: number,
  limit: number,
): boolean {
  return task !== "outpaint" && fileSize > limit;
}

export function preparedImageEditSourceWithinLimit(
  fileSize: number,
  limit: number,
): boolean {
  return fileSize <= limit;
}
