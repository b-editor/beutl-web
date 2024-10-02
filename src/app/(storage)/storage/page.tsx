import { Progress } from "@/components/ui/progress";
import authOrSignIn from "@/lib/auth-guard";
import { cn } from "@/lib/utils";
import { prisma } from "@/prisma";
import { File, Image } from "lucide-react";
import { retrieveFiles } from "./actions";
import { List } from "./components";

export default async function Page() {
  const session = await authOrSignIn();
  const files = await retrieveFiles();
  let totalSize = 0;
  for (const file of files) {
    totalSize += Number(file.size) / (1024 * 1024);
  }

  return (

    <div>
      <div className="border-b bg-card">
        <div className="container max-w-6xl mx-auto py-12 px-4 flex flex-col gap-12">
          <h2 className="text-3xl font-semibold">ストレージ</h2>
          <div className="flex gap-2 flex-col">
            {/* <Button>新しい拡張機能を作成</Button>
            <Button variant="outline">ドキュメント</Button> */}
            <p>1.00GB 中 {totalSize.toFixed(2)}MB使用</p>
            <Progress value={totalSize} max={1024} />
          </div>
        </div>
      </div>
      <div className="container max-w-6xl mx-auto">
        <div className="mt-4 rounded-lg border text-card-foreground">
          <List data={files} />
        </div>
      </div>
    </div>
  )
}