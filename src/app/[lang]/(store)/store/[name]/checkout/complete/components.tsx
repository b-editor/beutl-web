import { getTranslation } from "@/app/i18n/server";
import { Button } from "@/components/ui/button";
import { CheckCircle, CircleSlash, Info } from "lucide-react";
import Link from "next/link";
import Stripe from "stripe";

async function getStatusContent(
  status: Stripe.PaymentIntent["status"],
  t: Awaited<ReturnType<typeof getTranslation>>["t"],
) {
  const STATUS_CONTENT_MAP: any = {
    succeeded: {
      title: t("store:paymentCompleted"),
      text: t("store:orderThankYou"),
      icon: () => <CheckCircle className="min-w-9 min-h-9 text-green-500" />,
    },
    processing: {
      title: t("store:processing"),
      text: t("store:orderProcessing"),
      icon: () => <Info className="min-w-9 min-h-9 text-gray-500" />,
    },
    requires_payment_method: {
      title: t("error"),
      text: t("store:paymentFailed"),
      icon: () => <CircleSlash className="min-w-9 min-h-9 text-red-500" />,
    },
    default: {
      title: t("error"),
      text: t("store:somethingWentWrong"),
      icon: () => <CircleSlash className="min-w-9 min-h-9 text-red-500" />,
    },
  };

  return STATUS_CONTENT_MAP[status];
}

export async function ClientPage({
  lang,
  name,
  status,
}: {
  lang: string;
  name: string;
  status: Stripe.PaymentIntent["status"];
}) {
  const { t } = await getTranslation(lang);
  const statusContent = await getStatusContent(status, t);
  return (
    <div className="h-full flex flex-col justify-between gap-6">
      <div>
        <div className="flex gap-2 items-center">
          {statusContent.icon()}
          <h2 className="text-2xl font-bold text-wrap">
            {statusContent.title}
          </h2>
        </div>
        <div className="mt-4">{statusContent.text}</div>
      </div>
      <div className="flex flex-col gap-2">
        <Button asChild>
          <Link href={`/${lang}/store/${name}`}>
            {t("store:returnToProductPage")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
