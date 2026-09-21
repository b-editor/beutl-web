export type VideoDurationStatus = {
  reading: boolean;
  error: { fileName: string; reason: "unreadable" | "tooShort" | "tooLong"; limit?: number } | null;
};

// File identity matters: an earlier selection with the same name and size
// must not validate a newly selected clip while its metadata is still loading.
export function videoDurationStatus(
  files: readonly File[],
  durations: ReadonlyMap<File, number | null>,
  minimum: number | null,
  maximum: number | null,
): VideoDurationStatus {
  if (files.some((file) => !durations.has(file))) return { reading: true, error: null };
  for (const file of files) {
    const seconds = durations.get(file);
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
      return { reading: false, error: { fileName: file.name, reason: "unreadable" } };
    }
    if (minimum !== null && seconds < minimum) {
      return { reading: false, error: { fileName: file.name, reason: "tooShort", limit: minimum } };
    }
    if (maximum !== null && seconds > maximum) {
      return { reading: false, error: { fileName: file.name, reason: "tooLong", limit: maximum } };
    }
  }
  return { reading: false, error: null };
}

export async function readVideoDurationSeconds(file: File, signal: AbortSignal): Promise<number | null> {
  signal.throwIfAborted();
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "metadata";
  video.muted = true;
  video.style.position = "fixed";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  video.setAttribute("aria-hidden", "true");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (seconds: number | null, aborted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      video.onloadedmetadata = null;
      video.onerror = null;
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // A media element that failed to load still needs its URL revoked.
      }
      video.remove();
      URL.revokeObjectURL(url);
      if (aborted) reject(signal.reason);
      else resolve(seconds);
    };
    const abort = () => finish(null, true);
    const timer = setTimeout(() => finish(null), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    video.onloadedmetadata = () => finish(
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
    );
    video.onerror = () => finish(null);
    try {
      // Some browsers do not load metadata on a detached media element.
      document.body.appendChild(video);
      video.src = url;
      video.load();
    } catch {
      finish(null);
    }
  });
}
