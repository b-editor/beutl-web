"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useState, useTransition } from "react";
import { updateInterval, updatePricing } from "./actions";
import type { Package } from "./types";

type Pricing = {
  currency: string;
  price: number;
  fallback: boolean;
};

export function PackagePricingForm({ pkg }: { pkg: Package }) {
  const [pricings, setPricings] = useState<Pricing[]>(
    pkg.packagePricing.map((p) => ({
      currency: p.currency,
      price: p.price,
      fallback: p.fallback,
    })),
  );
  const [pendingInterval, startIntervalTransition] = useTransition();
  const [pendingPricing, startPricingTransition] = useTransition();
  const { toast } = useToast();

  const handleIntervalChange = useCallback(
    (value: string) => {
      const interval =
        value === "FREE" ? null : (value as "ONCE" | "MONTHLY" | "YEARLY");
      startIntervalTransition(async () => {
        const res = await updateInterval({
          packageId: pkg.id,
          interval,
        });
        if (!res.success) {
          toast({
            title: "エラー",
            description: res.message,
            variant: "destructive",
          });
        } else {
          toast({ title: "成功", description: "支払い間隔を更新しました" });
        }
      });
    },
    [pkg.id, toast],
  );

  const handleAddPricing = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const formData = new FormData(form);
      const currency = (formData.get("currency") as string).toUpperCase();
      const price = Number.parseInt(formData.get("price") as string, 10);
      const fallback = formData.get("fallback") === "on";

      if (!currency || currency.length !== 3) {
        toast({
          title: "エラー",
          description: "通貨コードは3文字で入力してください",
          variant: "destructive",
        });
        return;
      }
      if (Number.isNaN(price) || price < 0) {
        toast({
          title: "エラー",
          description: "価格は0以上の整数で入力してください",
          variant: "destructive",
        });
        return;
      }
      if (pricings.some((p) => p.currency === currency)) {
        toast({
          title: "エラー",
          description: "この通貨は既に追加されています",
          variant: "destructive",
        });
        return;
      }

      const newPricings = [...pricings, { currency, price, fallback }];
      setPricings(newPricings);
      form.reset();
    },
    [pricings, toast],
  );

  const handleDeletePricing = useCallback(
    (currency: string) => {
      setPricings(pricings.filter((p) => p.currency !== currency));
    },
    [pricings],
  );

  const handleSavePricings = useCallback(() => {
    startPricingTransition(async () => {
      const res = await updatePricing({
        packageId: pkg.id,
        pricings,
      });
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
      } else {
        toast({ title: "成功", description: "価格設定を更新しました" });
      }
    });
  }, [pkg.id, pricings, toast]);

  return (
    <div>
      <h4 className="font-bold text-lg mt-6 border-b pb-2">
        価格設定 (管理者)
      </h4>

      <div className="flex flex-col gap-2 my-4">
        <Label>支払い間隔</Label>
        <Select
          defaultValue={pkg.interval ?? "FREE"}
          onValueChange={handleIntervalChange}
          disabled={pendingInterval}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="FREE">無料</SelectItem>
            <SelectItem value="ONCE">一度のみ</SelectItem>
            <SelectItem value="MONTHLY">月額</SelectItem>
            <SelectItem value="YEARLY">年額</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      <div className="flex flex-col gap-2 my-4">
        <Label>価格一覧</Label>
        {pricings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            価格が設定されていません
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {pricings.map((p) => (
              <div
                key={p.currency}
                className="flex items-center gap-2 text-sm"
              >
                <span className="font-mono w-10">{p.currency}</span>
                <span className="flex-1">{p.price.toLocaleString()}</span>
                {p.fallback && (
                  <span className="text-xs text-muted-foreground">
                    デフォルト
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleDeletePricing(p.currency)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="w-fit">
              <Plus className="h-4 w-4 mr-1" />
              価格を追加
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72">
            <form className="flex flex-col gap-3" onSubmit={handleAddPricing}>
              <div className="flex flex-col gap-1">
                <Label htmlFor="currency">通貨コード</Label>
                <Input
                  name="currency"
                  id="currency"
                  placeholder="JPY"
                  maxLength={3}
                  className="h-8"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="price">価格</Label>
                <Input
                  name="price"
                  id="price"
                  type="number"
                  min={0}
                  placeholder="1000"
                  className="h-8"
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox name="fallback" id="fallback" value="on" />
                <Label htmlFor="fallback" className="text-sm">
                  デフォルト通貨
                </Label>
              </div>
              <Button type="submit" size="sm">
                追加
              </Button>
            </form>
          </PopoverContent>
        </Popover>

        <Button
          onClick={handleSavePricings}
          disabled={pendingPricing}
          size="sm"
          className="w-fit mt-2"
        >
          {pendingPricing && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          価格を保存
        </Button>
      </div>
    </div>
  );
}
