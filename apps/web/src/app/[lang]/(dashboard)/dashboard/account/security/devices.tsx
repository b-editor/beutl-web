"use client";

import { useState } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Separator } from "@beutl/ui/ui/separator";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@beutl/ui/ui/alert-dialog";
import { disconnectDevice } from "./device-actions";

type Device = { id: string; name: string; createdAt: string };
export function ConnectedDevices({
  lang,
  initialDevices,
}: {
  lang: string;
  initialDevices: Device[];
}) {
  const { t } = useTranslation(lang);
  const [devices, setDevices] = useState(initialDevices);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  async function disconnect(id: string) {
    setPending(id);
    setFailed(false);
    try {
      const result = await disconnectDevice(id);
      if (!result.success) throw new Error("Disconnect failed");
      setDevices((items) => items.filter((item) => item.id !== id));
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }
  return (
    <section className="mt-4 rounded-lg border text-card-foreground">
      <h3 className="m-6 mb-4 font-bold">{t("account:devices.title")}</h3>
      <Separator />
      <div className="space-y-4 px-6 py-4">
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t("account:devices.failed")}
          </p>
        )}
        {devices.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("account:devices.empty")}</p>
        )}
        {devices.map((device) => (
          <div key={device.id} className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium wrap-anywhere">{device.name}</p>
              <p className="text-sm text-muted-foreground">
                Beutl Desktop ·{" "}
                {new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(
                  new Date(device.createdAt),
                )}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={pending !== null}>
                  {t("account:devices.disconnect")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("account:devices.confirm")}</AlertDialogTitle>
                  <AlertDialogDescription className="wrap-anywhere">
                    {device.name}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void disconnect(device.id)}>
                    {t("account:devices.disconnect")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ))}
      </div>
    </section>
  );
}
