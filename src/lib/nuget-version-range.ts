import semver from "semver"; 

export function isValidNuGetVersionRange(range: string): boolean {
  const trimmedRange = range.trim();

  // 正規表現で形式を確認
  const regex = /^([\(\[])?\s*([^,]*)\s*,\s*([^,\)\]]*)\s*([\)\]])?$/;
  const match = trimmedRange.match(regex);

  if (!match) {
    return false; // 正規表現に一致しない場合は無効
  }

  const [, startSymbol, minVersionStr, maxVersionStr, endSymbol] = match;

  // 開始と終了の記号が正しいか確認
  const validStartSymbol = startSymbol === "[" || startSymbol === "(" || startSymbol === undefined;
  const validEndSymbol = endSymbol === "]" || endSymbol === ")" || endSymbol === undefined;

  if (!validStartSymbol || !validEndSymbol) {
    return false;
  }

  // バージョン部分が空文字列か正しいSemantic Version形式かを確認
  const isValidMinVersion = !minVersionStr || semver.valid(minVersionStr) !== null;
  const isValidMaxVersion = !maxVersionStr || semver.valid(maxVersionStr) !== null;

  return isValidMinVersion && isValidMaxVersion;
}