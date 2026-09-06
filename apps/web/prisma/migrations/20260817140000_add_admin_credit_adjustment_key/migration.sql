-- 管理者による追加クレジットの手動調整に一意キーを持たせる。
--
-- 台帳のほかの金銭移動は二重適用できない: 購入は "stripePaymentId" が一意、
-- 消費と返金は ("aiJobId", "kind") が一意、返金取消は返金キーの三つ組が一意。
-- 手動調整だけは束ねる相手が無く、読み取り → 更新 → 追記の形なので、確定ボタンの
-- 二度押しや Server Action の再送で同じ付与が二回適用されていた。
--
-- 既存行は NULL のまま残す。CockroachDB の一意インデックスは NULL を互いに
-- 区別するため、過去の調整が重複と見なされることはない。
ALTER TABLE "CreditTransaction" SET (schema_locked = false);

ALTER TABLE "CreditTransaction" ADD COLUMN "adminAdjustmentKey" STRING;

CREATE UNIQUE INDEX "CreditTransaction_adminAdjustmentKey_key"
ON "CreditTransaction"("adminAdjustmentKey");

ALTER TABLE "CreditTransaction" SET (schema_locked = true);
