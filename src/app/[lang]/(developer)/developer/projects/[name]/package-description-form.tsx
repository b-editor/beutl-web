"use client";

import { Button } from "@/components/ui/button";
import type { Package } from "./types";
import { Edit, Loader2, Save } from "lucide-react";
import { useCallback, useReducer, useState, useTransition } from "react";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { updateDescription } from "./actions";

export function PackageDescriptionForm({ pkg }: { pkg: Package }) {
  const [edit, toggleEdit] = useReducer((edit) => !edit, false);
  const [pending, startTransition] = useTransition();
  const [description, setDescription] = useState(pkg.description);
  const { toast } = useToast();

  const handleSave = useCallback(async () => {
    startTransition(async () => {
      const res = await updateDescription({ packageId: pkg.id, description });
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
      } else {
        toggleEdit();
      }
    });
  }, [description, pkg.id, toast]);

  return (
    <div>
      <div className="flex justify-between items-center mt-6 border-b pb-2">
        <h3 className="font-bold text-xl">説明</h3>
        {!edit && (
          <Button
            size="icon"
            variant="ghost"
            className="w-8 h-8"
            onClick={toggleEdit}
          >
            <Edit className="w-4 h-4" />
          </Button>
        )}
      </div>
      {!edit && (
        <p
          className="mt-4 whitespace-pre-wrap"
          style={{ wordWrap: "break-word" }}
        >
          {pkg.description}
        </p>
      )}
      {edit && (
        <>
          <Textarea
            maxLength={1000}
            className="mt-4 mb-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={pending}>
              {pending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              保存
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                toggleEdit();
                setDescription(pkg.description);
              }}
            >
              キャンセル
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
