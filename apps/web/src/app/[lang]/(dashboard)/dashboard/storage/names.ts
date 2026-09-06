import { STORAGE_FILE_NAME_MAX_LENGTH } from "@beutl/core";

// 制御文字は Content-Disposition のヘッダーを壊すので受け付けない。フォルダー名も
// 同じ規則にして、ファイルと同じダイアログで扱えるようにする。
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function isValidStorageName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= STORAGE_FILE_NAME_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(name)
  );
}
