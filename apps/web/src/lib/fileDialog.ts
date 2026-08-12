export function showOpenFileDialog(
  { accept, multiple }: { accept?: string; multiple?: boolean } = {},
) {
  return new Promise<FileList | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept ?? "";
    input.multiple = multiple ?? false;
    input.onchange = () => {
      resolve(input.files);
    };
    input.click();
  });
}

export function showOpenDirectoryDialog() {
  return new Promise<FileList | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.onchange = () => {
      resolve(input.files);
    };
    input.click();
  });
}
