"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { createNewProject } from "./actions";
import { useActionState } from "react";
import { ErrorDisplay } from "@/components/error-display";
import SubmitButton from "@/components/submit-button";

export function Form() {
  const [state, dispatch] = useActionState(createNewProject, {});

  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <form action={dispatch}>
        <h2 className="font-bold text-2xl">新しいプロジェクトを作成</h2>
        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="packageId">
            パッケージID
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="text"
            id="packageId"
            name="packageId"
            autoComplete="off"
            placeholder="Company.Product"
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            半角英数字とピリオド、アンダースコアのみ
          </p>
          {state.errors?.packageId && (
            <ErrorDisplay
              className="mx-6 mb-6 -mt-2"
              errors={state.errors.packageId}
            />
          )}
        </div>
        <div className="rounded-lg border text-card-foreground mt-4 p-6">
          {state.message && (
            <p className="text-sm font-medium text-destructive mb-6">
              {state.message}
            </p>
          )}
          <div className="flex gap-2">
            <SubmitButton>作成</SubmitButton>
            {/* <Button variant="outline">
              <Upload className="w-4 h-4 mr-2" />
              パッケージファイルから作成
            </Button> */}
          </div>
        </div>
      </form>
    </div>
  );
}
