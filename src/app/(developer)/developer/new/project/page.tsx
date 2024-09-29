import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Upload } from "lucide-react";

export default function Page() {
  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <h2 className="font-bold text-2xl">新しいプロジェクトを作成</h2>
      <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
        <Label className="font-bold text-md m-6 mb-4" htmlFor="displayName">名前</Label>
        <Separator />
        <Input className="max-w-sm w-auto mt-4 mx-6" type="text" id="displayName" name="displayName" maxLength={50} />
        <p className="text-sm text-muted-foreground m-6 mt-2">50文字以下</p>
        {/* {state.errors?.displayName && <ErrorDisplay className="mx-6 mb-6 -mt-2" errors={state.errors.displayName} />} */}
      </div>
      <div className="rounded-lg border text-card-foreground flex gap-2 mt-4 p-6">
        <Button>
          作成
        </Button>
        <Button variant="outline">
          <Upload className="w-4 h-4 mr-2" />
          パッケージファイルから作成
        </Button>
      </div>
    </div>
  )
}