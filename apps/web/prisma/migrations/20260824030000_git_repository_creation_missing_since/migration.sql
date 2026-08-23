-- 相手が見つからなくなった時刻。
-- 作成の待ち時間を切った後も Forgejo 側の処理は続くことがあり、1 回見つからない
-- だけで予約を外すと、その後に現れた預かりものが誰にも追われないまま残る。
ALTER TABLE "GitRepositoryCreation" ADD COLUMN IF NOT EXISTS "missingSince" TIMESTAMP(3);
