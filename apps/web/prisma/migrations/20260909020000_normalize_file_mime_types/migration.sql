-- 保存済みの mimeType から、両端の空白と RFC 2045 が許す ";" 前後の空白を取り除く。
-- 一覧の種類フィルタ (packages/db/src/file.ts storageFileKindWhere) は "type" か
-- "type;" で始まる形しか見ないので、以前のアップロードで "type ; param" のまま
-- 保存された行は「ドキュメント」ではなく「その他」に落ちる。書き込み側は同じ
-- 正規化 (storedMimeType) を通す。配信ヘッダとしては同じ意味の値。
-- データ更新のみ・再実行可能・メンテナンス窓不要 (差のある行だけ書く)。
UPDATE "File"
SET "mimeType" = regexp_replace(btrim("mimeType"), '\s*;\s*', ';', 'g')
WHERE "mimeType" <> regexp_replace(btrim("mimeType"), '\s*;\s*', ';', 'g');
