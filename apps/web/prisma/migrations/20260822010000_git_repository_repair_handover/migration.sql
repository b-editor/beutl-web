-- 管理者の手元で組み立て中のリポジトリを、渡す先まで含めて控える。
-- 譲渡の前に落ちた預かりものが「揃っているから片付いた」と見なされ、管理者所有の
-- まま残って同じ名前を永久に塞ぐのを防ぐ。
ALTER TABLE "GitRepositoryRepair" ADD COLUMN IF NOT EXISTS "intendedOwner" STRING;
ALTER TABLE "GitRepositoryRepair" ADD COLUMN IF NOT EXISTS "intendedName" STRING;
ALTER TABLE "GitRepositoryRepair" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
