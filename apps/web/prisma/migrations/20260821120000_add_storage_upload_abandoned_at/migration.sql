-- 掃除が「この行のパートは自分が捨てる」と宣言した時刻。
--
-- 一覧を引いてから順番が回ってくるまでの間に、そのアップロードが完了している
-- ことがある。読み直すだけでは足りない——読んだ直後に完了されると、File が指す
-- ことになるオブジェクトを消してしまう。宣言できた行にはもう控えを書けないので、
-- そのあと中止してもオブジェクトを消しても、File が消えたものを指すことはない。
--
-- 宣言済みの行はパートを抱えていないので、進行中の合計にも本数にも数えない。
ALTER TABLE "StorageUpload" SET (schema_locked = false);

ALTER TABLE "StorageUpload" ADD COLUMN "abandonedAt" TIMESTAMP(3);

ALTER TABLE "StorageUpload" SET (schema_locked = true);
