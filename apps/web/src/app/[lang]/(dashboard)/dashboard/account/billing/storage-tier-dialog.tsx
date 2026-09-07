"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import {
  formatAmount,
  formatBytes,
  STORAGE_TIER_IDS,
  storageTierOf,
  type StorageTierId,
} from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@beutl/ui/ui/dialog";
import { changeStorageTier, createStorageCheckout } from "./storage-actions";
import type { StorageTierPrices } from "./queries";

// One dialog for picking a storage tier, whether the user is subscribing or
// switching. The chosen tier travels as a plain form field to the server
// action, which validates it again and redirects; the dialog only decides
// which action to post to and keeps the button disabled until a tier is
// picked.
//
// A new subscription goes on to Stripe Checkout, which shows the price before
// anything is charged. A change does not: the difference is invoiced at once.
// So the change dialog shows every tier's monthly price and refuses a tier
// whose price it cannot show.
export function StorageTierDialog({
  lang,
  currentTier,
  tiers = STORAGE_TIER_IDS,
  prices,
}: {
  lang: string;
  // null when the user has no storage subscription yet.
  currentTier: StorageTierId | null;
  tiers?: readonly StorageTierId[];
  prices: StorageTierPrices;
}) {
  const { t } = useTranslation(lang);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<StorageTierId | null>(null);
  const changing = currentTier !== null;
  const canPick = (tier: StorageTierId) =>
    tier !== currentTier && (!changing || prices[tier] !== null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={changing ? "outline" : "default"}>
          {t(
            changing
              ? "account:storagePlan.changeTier"
              : "account:storagePlan.choosePlan",
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form
          action={changing ? changeStorageTier : createStorageCheckout}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                changing
                  ? "account:storagePlan.changeTierTitle"
                  : "account:storagePlan.selectTierTitle",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                changing
                  ? "account:storagePlan.changeTierHint"
                  : "account:storagePlan.description",
              )}
            </DialogDescription>
          </DialogHeader>
          <div
            role="radiogroup"
            aria-label={t("account:storagePlan.selectTierTitle")}
            className="flex flex-col gap-2"
          >
            {tiers.map((tier) => {
              const isCurrent = tier === currentTier;
              const isSelected = tier === selected;
              const price = prices[tier];
              const disabled = !canPick(tier);
              return (
                <label
                  key={tier}
                  className={[
                    "flex items-center gap-3 rounded-lg border p-4 transition-colors",
                    disabled
                      ? "cursor-default opacity-60"
                      : "cursor-pointer hover:bg-accent",
                    isSelected ? "border-primary bg-accent" : "",
                  ].join(" ")}
                >
                  <input
                    type="radio"
                    name="tier"
                    value={tier}
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => setSelected(tier)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className={[
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground",
                    ].join(" ")}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2 font-bold">
                      {t(`account:billing.storageTier.${tier}`)}
                      {isCurrent && (
                        <Badge variant="secondary">
                          {t("account:storagePlan.currentTier")}
                        </Badge>
                      )}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t("account:storagePlan.tierQuota", {
                        quota: formatBytes(storageTierOf(tier).quotaBytes),
                      })}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-sm">
                    {price ? (
                      <>
                        <span className="font-bold">
                          {formatAmount(price.unitAmount, price.currency, lang)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {t("account:storagePlan.perMonth")}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("account:storagePlan.priceUnavailable")}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <SubmitButton disabled={selected === null || !canPick(selected)}>
              {t(
                changing
                  ? "account:storagePlan.confirmChange"
                  : "account:storagePlan.confirmSubscribe",
              )}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
