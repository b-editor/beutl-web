-- 所有者名も Forgejo の名前空間に合わせる。
--
-- 一意制約は (ownerUsername, normalizedName) だが、所有者側は生のまま入っていた。
-- Forgejo はユーザー名も大文字小文字を区別しないので、Someone/proj と someone/proj が
-- 別の予約として通ってしまう。既存行も小文字へ揃える。
--
-- **大文字違いの重複がある環境ではここで止まる。** 予約は一時的な行なので、
-- 止まった場合は次で重複を確かめ、片方を消してからやり直す (消す前に、その
-- holdingName のリポジトリが管理者の名前空間に残っていないか確かめること)。
--
--   SELECT lower("ownerUsername"), "normalizedName", count(*), array_agg("holdingName")
--   FROM "GitRepositoryCreation" GROUP BY 1, 2 HAVING count(*) > 1;
UPDATE "GitRepositoryCreation"
SET "ownerUsername" = lower("ownerUsername")
WHERE "ownerUsername" <> lower("ownerUsername");
