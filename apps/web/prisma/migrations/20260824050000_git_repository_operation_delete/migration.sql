-- 削除も名前を押さえてから行う。名前で引いてから送るまでの間に、その名前が別の
-- リポジトリに渡ることがある。消すのは取り返しがつかない。
ALTER TYPE "GitRepositoryOperation" ADD VALUE IF NOT EXISTS 'DELETE';

-- 旧版で積まれた改名の予約を CREATE のまま扱うと、後始末が預かりものの流れに
-- 入り、利用者が編集した .gitattributes を「直す」対象にしてしまう。
UPDATE "GitRepositoryCreation" SET "operation" = 'RENAME'
WHERE "operation" = 'CREATE' AND "holdingName" LIKE 'beutl-rename-%';
