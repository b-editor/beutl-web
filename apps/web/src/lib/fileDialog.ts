export function showOpenFileDialog(
  { accept }: { accept: string } = { accept: "" },
) {
  return new Promise<FileList | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      resolve(input.files);
    };
    input.click();
  });
}
