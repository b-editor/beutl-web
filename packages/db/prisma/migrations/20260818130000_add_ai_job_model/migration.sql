-- どのモデルで走ったジョブかを記録する。
--
-- inputParams に入れない理由は 2 つ。履歴の sanitizedInputParams は kind ごとの
-- ホワイトリストなので毎回足す必要があること、そして利用状況の集計
-- (groupBy kind) にモデル軸を足せるようにしたいこと。
--
-- この列が無い時代のジョブは NULL のまま。NULL の再実行はその操作の既定モデルで
-- 走る (当時もそれ 1 つしか無かったので同じ結果になる)。モデル名が記録されている
-- のにそれが無効化されている場合は、既定へ落とさず拒否する — 黙って別のモデルで
-- 作り直して料金を取ることになるため。
ALTER TABLE "AiJob" SET (schema_locked = false);

ALTER TABLE "AiJob" ADD COLUMN "model" STRING;

ALTER TABLE "AiJob" SET (schema_locked = true);
