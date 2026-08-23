-- 控えがどの予約から生まれたかを持つ。
-- 渡し切ったときに owner と名前で予約を外すと、一度解放されて作り直された
-- 新しい予約を消してしまう。世代ごと指せるようにする。
ALTER TABLE "GitRepositoryRepair" ADD COLUMN IF NOT EXISTS "reservationId" STRING;
