"use client";

import { useCallback, useReducer, useState, useTransition } from "react";
import { Package } from "./types";
import { Button } from "@/components/ui/button";
import { Edit, Loader2, Plus, Save } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export function ReleaseForm({ pkg }: { pkg: Package }) {
  const [edit, toggleEdit] = useReducer((edit) => !edit, false);
  const [pending, startTransition] = useTransition();
  const [release, setRelease] = useState(pkg.Release[0]);
  const [title, setTitle] = useState(release.title);
  const [description, setDescription] = useState(release.description);
  const [targetVersion, setTargetVersion] = useState(release.targetVersion);

  const handleReset = useCallback(() => {
    setTitle(release.title);
    setDescription(release.description);
    setTargetVersion(release.targetVersion);
  }, []);

  const handleSave = useCallback(async () => {

  }, []);

  return (
    <div>
      <div className="flex items-center mt-6 border-b pb-2 gap-2">
        <Select value={release.id} onValueChange={(e) => { setRelease(pkg.Release.find((r) => r.id === e)!) }}>
          <SelectTrigger className="font-bold text-xl border-none bg-transparent px-0 pr-3 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pkg.Release.map((release) => (
              <SelectItem key={release.id} value={release.id}>
                {release.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!edit && (
          <>
            <Button size="icon" variant="ghost" className="w-8 h-8" onClick={toggleEdit}>
              <Plus className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" className="w-8 h-8" onClick={toggleEdit}>
              <Edit className="w-4 h-4" />
            </Button>
          </>
        )}
      </div>
      {!edit && (
        <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
          {release.title}<br />
          {release.description}
        </p>
      )}
      {edit && (
        <>
          <Label htmlFor="release-title" className="mt-4">タイトル</Label>
          <Input
            id="release-title"
            placeholder="タイトル"
            className="my-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Label htmlFor="release-description" className="mt-4">説明</Label>
          <Textarea
            id="release-description"
            placeholder="説明"
            maxLength={1000}
            className="my-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Label htmlFor="release-target-version" className="mt-4">ターゲットバージョン</Label>
          <Input
            id="release-target-version"
            placeholder="ターゲットバージョン"
            className="my-2"
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
          />
          <Label className="mt-4">パッケージファイル</Label>
          <Button variant="outline" className="flex w-full justify-start my-2">
            ファイルを選択
          </Button>
          <div className="flex items-center space-x-2 mt-4">
            <Checkbox id="release-public" />
            <Label htmlFor="release-public">公開する</Label>
          </div>
          <div className="flex gap-2 mt-4 flex-wrap justify-between">
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={pending}>
                {pending
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Save className="w-4 h-4 mr-2" />}
                保存
              </Button>
              <Button variant="outline" onClick={() => {
                toggleEdit();
                handleReset();
              }}>
                キャンセル
              </Button>
            </div>
            <Button variant="destructive">
              削除
            </Button>
          </div>
        </>
      )}
    </div>
  )
}