"use client";

import { Edit, Loader2, MoreVertical, Save, Upload } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCallback, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { type State, updateDisplayNameAndShortDescription, deletePackage, changePackageVisibility, uploadIcon } from "./actions";
import { ErrorDisplay } from "@/components/error-display";
import { showOpenFileDialog } from "@/lib/fileDialog";
import { useToast } from "@/hooks/use-toast";
import type { Package } from "./types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

export function PackageInfoForm({ pkg }: { pkg: Package }) {
  const [edit, setEdit] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState(pkg.displayName || "");
  const [shortDescription, setShortDescription] = useState(pkg.shortDescription);
  const [state, setState] = useState<State>({});
  const [pendingActions, startDropdownActions] = useTransition();
  const [pendingIcon, startUploadIcon] = useTransition();
  const { toast } = useToast();

  const handleSubmit = useCallback(async () => {
    try {
      setPending(true);
      const data = new FormData();
      data.append("displayName", displayName || "");
      data.append("shortDescription", shortDescription);
      data.append("id", pkg.id);
      const newState = await updateDisplayNameAndShortDescription(state, data);
      setState(newState);

      setEdit(!newState.success);
    } finally {
      setPending(false);
    }
  }, [displayName, shortDescription, pkg.id, state]);

  const handleCancel = useCallback(() => {
    setDisplayName(pkg.displayName || "");
    setShortDescription(pkg.shortDescription);
    setState({});
    setEdit(false);
  }, [pkg.displayName, pkg.shortDescription]);

  const handleDelete = useCallback(async () => {
    startDropdownActions(async () => {
      const res = await deletePackage(pkg.id);
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
      }
    });
  }, [pkg.id, toast]);

  const handleChangeVisibility = useCallback(async () => {
    startDropdownActions(async () => {
      const res = await changePackageVisibility(pkg.id, !pkg.published);
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "成功",
          description: "変更しました",
        });
      }
    });
  }, [pkg.id, pkg.published, toast]);

  const handleUploadIconClick = useCallback(async () => {
    const files = await showOpenFileDialog({ accept: "image/*" });

    const file = files?.[0];
    if (!file) {
      return;
    }
    startUploadIcon(async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("id", pkg.id);
      const res = await uploadIcon(formData);
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
      }
    });
  }, [toast, pkg.id]);

  return (
    <>
      <div className="sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4">
          <div className="flex gap-4 w-full">
            <Button className="group p-0 w-16 h-16 bg-secondary hover:bg-secondary/90 relative" variant="ghost" onClick={handleUploadIconClick}>
              {pkg.iconFileUrl && <Image width={64} height={64}
                className="w-16 h-16 max-w-fit rounded-md group-hover:opacity-80"
                alt="Package icon" src={pkg.iconFileUrl} />}
              {pendingIcon
                ? <Loader2 className="w-6 h-6 animate-spin absolute" />
                : <Upload className="w-6 h-6 group-hover:visible invisible absolute" />}
            </Button>

            <div className="flex-1">
              <h2 className={cn("font-bold text-2xl", edit && "hidden")}>{pkg.displayName || pkg.name}</h2>
              <Input className={cn(!edit && "hidden")}
                value={displayName}
                type="text"
                placeholder="表示名 (空白の場合IDが表示されます)"
                onChange={(e) => setDisplayName(e.target.value)}
              />
              {state?.errors?.displayName && <ErrorDisplay errors={state.errors.displayName} />}
              <p className="text-muted-foreground text-sm font-medium">{pkg.name}</p>
            </div>
          </div>

          {!edit &&
            <div className="flex gap-2">
              <Button variant="ghost" size="icon" onClick={() => setEdit(true)}>
                <Edit className="w-4 h-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" disabled={pendingActions}>
                    {pendingActions ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreVertical className="w-4 h-4" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>操作</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setDeleteDialog(true)}>削除</DropdownMenuItem>
                  <DropdownMenuItem onClick={handleChangeVisibility}>{pkg.published ? "非公開にする" : "公開する"}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>}
        </div>
      </div>
      <p className={cn("mt-4 text-foreground/70", edit && "hidden")}>{pkg.shortDescription}</p>
      <Input
        className={cn("mt-4", !edit && "hidden")}
        value={shortDescription}
        onChange={e => setShortDescription(e.target.value)}
      />
      {state?.errors?.shortDescription && <ErrorDisplay errors={state.errors.shortDescription} />}

      <div className="flex gap-2 justify-end mt-4">
        <Button
          variant="default"
          size="default"
          className={cn(!edit && "hidden")}
          disabled={pending}
          onClick={handleSubmit}
        >
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          保存
        </Button>
        <Button
          variant="outline"
          size="default"
          className={cn(!edit && "hidden")}
          disabled={pending}
          onClick={handleCancel}
        >
          キャンセル
        </Button>
      </div>

      <AlertDialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>本当に削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。このパッケージに関連するすべてのデータが削除されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>削除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
