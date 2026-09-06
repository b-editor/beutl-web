export function showOpenFileDialog(
  { accept, multiple }: { accept?: string; multiple?: boolean } = {},
) {
  return new Promise<FileList | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept ?? "";
    input.multiple = multiple ?? false;
    let settled = false;
    const finish = (files: FileList | null) => {
      if (settled) return;
      settled = true;
      input.onchange = null;
      input.removeEventListener("cancel", cancelled);
      resolve(files);
    };
    const cancelled = () => finish(null);
    input.onchange = () => finish(input.files);
    // File inputs do not dispatch change when their picker is dismissed. The
    // cancel event is the matching terminal path (and also covers reselecting
    // the same file), so callers can always release locks held around the dialog.
    input.addEventListener("cancel", cancelled);
    input.click();
  });
}
