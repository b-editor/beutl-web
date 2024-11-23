"use client";

import { Button } from "@/components/ui/button";
import { CheckCircle, CircleSlash, Info } from "lucide-react";
import Stripe from "stripe";

const STATUS_CONTENT_MAP: any = {
  succeeded: {
    title: "決済完了",
    text: "ご注文ありがとうございます。決済が正常に完了しました。",
    icon: () => <CheckCircle className="min-w-9 min-h-9 text-green-500" />,
  },
  processing: {
    title: "処理中",
    text: "ご注文ありがとうございます。支払い処理中です。",
    icon: () => <Info className="min-w-9 min-h-9 text-gray-500" />,
  },
  requires_payment_method: {
    title: "エラー",
    text: "支払いが成功しませんでした。もう一度お試しください。",
    icon: () => <CircleSlash className="min-w-9 min-h-9 text-red-500" />,
  },
  default: {
    title: "エラー",
    text: "何かがうまくいきませんでした。もう一度お試しください。",
    icon: () => <CircleSlash className="min-w-9 min-h-9 text-red-500" />,
  }
};

export function ClientPage({
  lang, name, status
}: {
  lang: string, name: string, status: Stripe.PaymentIntent["status"]
}) {
  return (
    <div className="h-full flex flex-col justify-between gap-6">
      <div>
        <div className="flex gap-2 items-center">
          {STATUS_CONTENT_MAP[status].icon()}
          <h2 className="text-2xl font-bold text-wrap">{STATUS_CONTENT_MAP[status].title}</h2>
        </div>
        <div className="mt-4">
          {STATUS_CONTENT_MAP[status].text}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button>商品ページに戻る</Button>
      </div>
    </div>
  )
}
