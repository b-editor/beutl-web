"use client";

import { Edit, Loader2, MoreVertical, Save } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { type State, updateDisplayNameAndShortDescription, type retrievePackage } from "./actions";
import { ErrorDisplay } from "@/components/error-display";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;

export function PackageInfoForm({ pkg }: { pkg: Package }) {
  const [edit, setEdit] = useState(false);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState(pkg.displayName || "");
  const [shortDescription, setShortDescription] = useState(pkg.shortDescription);
  const [state, setState] = useState<State>({});

  const submit = useCallback(async () => {
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

  const cancel = useCallback(() => {
    setDisplayName(pkg.displayName || "");
    setShortDescription(pkg.shortDescription);
    setState({});
    setEdit(false);
  } , [pkg.displayName, pkg.shortDescription]);

  return (
    <>
      <div className="sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4">
          <div className="flex gap-4 w-full">
            {pkg.iconFile && <Image width={64} height={64}
              className="w-16 h-16 max-w-fit rounded-md"
              alt="Package icon" src={""} />}
            {!pkg.iconFile && <div className="w-16 h-16 rounded-md bg-secondary" />}

            <div className="flex-1">
              <h2 className={cn("font-bold text-2xl", edit && "hidden")}>{pkg.displayName || pkg.name}</h2>
              <Input className={cn(!edit && "hidden")}
                defaultValue={pkg.displayName || ""}
                value={displayName}
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
                  <Button variant="ghost" size="icon">
                    <MoreVertical className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>操作</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>削除</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>}
        </div>
      </div>
      <p className={cn("mt-4 text-foreground/70", edit && "hidden")}>{pkg.shortDescription}</p>
      <Input
        className={cn("mt-4", !edit && "hidden")}
        defaultValue={pkg.shortDescription}
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
          onClick={submit}
        >
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          保存
        </Button>
        <Button
          variant="outline"
          size="default"
          className={cn(!edit && "hidden")}
          disabled={pending}
          onClick={cancel}
        >
          キャンセル
        </Button>
      </div>
    </>
  )
}

export function ScreenshotForm({ pkg }: { pkg: Package }) {
  return (
    <>
      <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
      {/* <Carousel className="mt-4">
        <CarouselContent>
          {Object.entries(pkg.PackageScreenshot).map((item) => (
            <CarouselItem className="w-min max-w-min min-w-min" key={item[0]}>
              <Image className="rounded max-w-min h-80 aspect-auto" alt="Screenshot" width={1280} height={720} src={item[1]} />
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="max-lg:hidden left-0 -translate-x-1/2 w-8 h-8" />
        <CarouselNext className="max-lg:hidden right-0 translate-x-1/2 w-8 h-8" />
      </Carousel> */}
    </>
  )
}