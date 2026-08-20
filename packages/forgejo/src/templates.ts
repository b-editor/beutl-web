// Beutl プロジェクト用リポジトリの初期ファイル。
//
// beutl-web がリポジトリを作るとき、この 2 つを最初のコミットに含める。
// git-server リポジトリの templates/ にも同じ内容の参照用コピーがあるが、
// 実際にコミットされるのはこちらの定義。

export const GITATTRIBUTES_TEMPLATE = `# Beutl プロジェクト用の既定 .gitattributes。
# beutl-web がリポジトリを作るとき、この内容を初期コミットに含める。

# --- プロジェクトファイル --------------------------------------------------
# .bep / .scene / .belm は WriteIndented な JSON なので、行単位の差分が意味を持つ。
# 改行が OS 間で揺れると差分が丸ごと汚れるため LF に固定する。
*.bep   text eol=lf
*.scene text eol=lf
*.belm  text eol=lf
*.json  text eol=lf
# SVG はテキスト。Beutl はファイルとしてではなくパスデータの文字列として扱うので、
# LFS に載せる理由がない (差分が読めなくなるだけ)。
*.svg   text eol=lf

# --- 素材は Git LFS ---------------------------------------------------------
# 拡張子を [mM][oO][vV] のように書いているのは、大文字小文字を問わず拾うため。
# gitattributes の照合は core.ignoreCase が false の環境 (Linux の通常の
# チェックアウト) では大文字小文字を区別する。カメラが吐く .MOV や .JPG が
# LFS を素通りし、数 GiB の動画が通常の git オブジェクトとして入ってしまう。
# 動画
*.[mM][pP]4 filter=lfs diff=lfs merge=lfs -text
*.[mM][oO][vV] filter=lfs diff=lfs merge=lfs -text
*.[mM][kK][vV] filter=lfs diff=lfs merge=lfs -text
*.[wW][eE][bB][mM] filter=lfs diff=lfs merge=lfs -text
*.[aA][vV][iI] filter=lfs diff=lfs merge=lfs -text
*.[mM]4[vV] filter=lfs diff=lfs merge=lfs -text

# 音声
*.[wW][aA][vV] filter=lfs diff=lfs merge=lfs -text
*.[mM][pP]3 filter=lfs diff=lfs merge=lfs -text
*.[fF][lL][aA][cC] filter=lfs diff=lfs merge=lfs -text
*.[aA][aA][cC] filter=lfs diff=lfs merge=lfs -text
*.[mM]4[aA] filter=lfs diff=lfs merge=lfs -text
*.[oO][gG][gG] filter=lfs diff=lfs merge=lfs -text

# 画像
*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text
*.[jJ][pP][gG] filter=lfs diff=lfs merge=lfs -text
*.[jJ][pP][eE][gG] filter=lfs diff=lfs merge=lfs -text
*.[gG][iI][fF] filter=lfs diff=lfs merge=lfs -text
*.[wW][eE][bB][pP] filter=lfs diff=lfs merge=lfs -text
*.[bB][mM][pP] filter=lfs diff=lfs merge=lfs -text
*.[tT][iI][fF] filter=lfs diff=lfs merge=lfs -text
*.[tT][iI][fF][fF] filter=lfs diff=lfs merge=lfs -text
*.[pP][sS][dD] filter=lfs diff=lfs merge=lfs -text
*.[eE][xX][rR] filter=lfs diff=lfs merge=lfs -text

# フォント・LUT
*.[tT][tT][fF] filter=lfs diff=lfs merge=lfs -text
*.[oO][tT][fF] filter=lfs diff=lfs merge=lfs -text
*.[tT][tT][cC] filter=lfs diff=lfs merge=lfs -text
*.[wW][oO][fF][fF] filter=lfs diff=lfs merge=lfs -text
*.[wW][oO][fF][fF]2 filter=lfs diff=lfs merge=lfs -text
*.[cC][uU][bB][eE] filter=lfs diff=lfs merge=lfs -text
`;

export const GITIGNORE_TEMPLATE = `# Beutl プロジェクト用の既定 .gitignore。
# beutl-web がリポジトリを作るとき、この内容を初期コミットに含める。

# エディタのローカル UI 状態 (開いていたタブ、スクロール位置など)。
# 端末ごとに異なる値で、共有すると衝突するだけなので追跡しない。
# (Beutl.Editor の EditorConstants.BeutlFolder / ViewStateFolder)
.beutl/view-state/

# プロキシメディアの保存先は既定ではプロジェクト外だが、
# プロジェクト内に置く設定にしている場合はここで除外する。
# proxy-cache/

# OS が勝手に作るもの
.DS_Store
Thumbs.db
desktop.ini
`;
