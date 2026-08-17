-- CreditTransaction の集計インデックスの先頭列を createdAt に直す。
-- 直前の 20260817120000 では (kind, createdAt) にしていたが、レポートの集計は
-- kind を指定せず期間だけで絞ってから kind で集約するため、先頭が kind だと
-- 範囲述語がインデックスに乗らず EXPLAIN が FULL SCAN になっていた。
-- kind を指定する管理者調整の集計も、期間で絞れれば十分に少ない行しか読まない。
--
-- 直前のマイグレーションを開発クラスタで適用したあとに設計を直したため、
-- 作成済みかどうかに関係なく同じ終状態になるよう IF EXISTS / IF NOT EXISTS で書く。
ALTER TABLE "AiJob" SET (schema_locked = false);

CREATE INDEX IF NOT EXISTS "AiJob_createdAt_idx" ON "AiJob"("createdAt" DESC);

ALTER TABLE "AiJob" SET (schema_locked = true);

ALTER TABLE "CreditTransaction" SET (schema_locked = false);

DROP INDEX IF EXISTS "CreditTransaction"@"CreditTransaction_kind_createdAt_idx";

CREATE INDEX IF NOT EXISTS "CreditTransaction_createdAt_idx" ON "CreditTransaction"("createdAt" DESC);

ALTER TABLE "CreditTransaction" SET (schema_locked = true);
