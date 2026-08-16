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

# --- 素材は Git LFS ---------------------------------------------------------
# 動画
*.mp4  filter=lfs diff=lfs merge=lfs -text
*.mov  filter=lfs diff=lfs merge=lfs -text
*.mkv  filter=lfs diff=lfs merge=lfs -text
*.webm filter=lfs diff=lfs merge=lfs -text
*.avi  filter=lfs diff=lfs merge=lfs -text
*.m4v  filter=lfs diff=lfs merge=lfs -text

# 音声
*.wav  filter=lfs diff=lfs merge=lfs -text
*.mp3  filter=lfs diff=lfs merge=lfs -text
*.flac filter=lfs diff=lfs merge=lfs -text
*.aac  filter=lfs diff=lfs merge=lfs -text
*.m4a  filter=lfs diff=lfs merge=lfs -text
*.ogg  filter=lfs diff=lfs merge=lfs -text

# 画像
*.png  filter=lfs diff=lfs merge=lfs -text
*.jpg  filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.gif  filter=lfs diff=lfs merge=lfs -text
*.webp filter=lfs diff=lfs merge=lfs -text
*.bmp  filter=lfs diff=lfs merge=lfs -text
*.tif  filter=lfs diff=lfs merge=lfs -text
*.tiff filter=lfs diff=lfs merge=lfs -text
*.psd  filter=lfs diff=lfs merge=lfs -text
*.exr  filter=lfs diff=lfs merge=lfs -text
*.svg  filter=lfs diff=lfs merge=lfs -text

# フォント・LUT
*.ttf  filter=lfs diff=lfs merge=lfs -text
*.otf  filter=lfs diff=lfs merge=lfs -text
*.ttc  filter=lfs diff=lfs merge=lfs -text
*.woff filter=lfs diff=lfs merge=lfs -text
*.woff2 filter=lfs diff=lfs merge=lfs -text
*.cube filter=lfs diff=lfs merge=lfs -text
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

