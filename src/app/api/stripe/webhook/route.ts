import { stripe } from "@/lib/stripe/config";
import { prisma } from "@/prisma";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ message: "No signature" }, { status: 400 });
  }

  // 署名を確認する
  const body = await request.text();
  const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_ENDPOINT_SECRET as string);

  switch (event.type) {
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (typeof paymentIntent.customer !== "string") {
        return NextResponse.json({ message: "paymentIntent.customer is not string" }, { status: 400 });
      }

      const userId = await prisma.customer.findFirst({
        where: {
          stripeId: paymentIntent.customer
        },
        select: {
          userId: true
        }
      });
      if (!userId) {
        return NextResponse.json({ message: "User not found" }, { status: 404 });
      }
      const pkg = await prisma.package.findFirst({
        where: {
          id: paymentIntent.metadata.packageId
        },
        select: {
          id: true
        }
      });
      if (!pkg) {
        return NextResponse.json({ message: "Package not found" }, { status: 404 });
      }
      await prisma.userPackage.create({
        data: {
          userId: userId.userId,
          packageId: pkg.id
        }
      });
      await prisma.userPaymentHistory.create({
        data: {
          userId: userId.userId,
          packageId: pkg.id,
          paymentId: paymentIntent.id,
        }
      })
      break;
    }
  }
  return NextResponse.json({ received: true });
}