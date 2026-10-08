// i18next は既定で補間値を HTML エスケープするが、React も描画時にテキストと
// 属性値をエスケープするため二重になり、日時の "/" やファイル名の "&" が
// "&#x2F;" や "&amp;" のまま画面に出る。React に描画する t() の補間に渡す。
// dangerouslySetInnerHTML に流す文言には渡さないこと。
export const RAW = { interpolation: { escapeValue: false } } as const;
