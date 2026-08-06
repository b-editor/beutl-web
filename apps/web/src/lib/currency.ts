import "server-only";
import { headers } from "next/headers";
import countryToCurrency from "country-to-currency";

async function getCountry(ipAddress: string) {
  const token = process.env.IPINFO_TOKEN;
  if (!token || !ipAddress) return null;

  const res = await fetch(`https://ipinfo.io/${ipAddress}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const json = await res.json();
  return json?.country || null;
}

export async function guessCurrency(): Promise<string | null> {
  if (process.env.NODE_ENV === "development") return "JPY";
  const h = await headers();
  const ipAddress = h.get("x-real-ip") || h.get("X-Forwarded-For")?.split(",")[0];
  if (!ipAddress) return null;
  const country = h.get("CF-IPCountry") || (await getCountry(ipAddress));
  if (!country) return null;
  const currency = countryToCurrency[country as keyof typeof countryToCurrency];
  return currency ?? null;
}
