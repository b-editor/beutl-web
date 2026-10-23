import "server-only";
import { headers } from "next/headers";
import countryToCurrency from "country-to-currency";
import { isIP } from "node:net";

async function getCountry(ipAddress: string) {
  const token = process.env.IPINFO_TOKEN;
  // Zone identifiers are local interface names, not addresses for geolocation.
  if (!token || !isIP(ipAddress) || ipAddress.includes("%")) return null;

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
  const ipAddress = (
    h.get("cf-connecting-ip") || h.get("x-real-ip") || h.get("X-Forwarded-For")?.split(",")[0]
  )?.trim();
  if (!ipAddress) return null;
  const country = h.get("CF-IPCountry") || (await getCountry(ipAddress));
  if (!country) return null;
  const currency = countryToCurrency[country as keyof typeof countryToCurrency];
  return currency ?? null;
}
