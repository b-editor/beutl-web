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

export async function guessCurrency() {
  if (process.env.NODE_ENV === "development") return "JPY";
  const h = await headers();
  const ipAddress = h.get("x-real-ip") || h.get("X-Forwarded-For")?.split(",")[0];
  console.log("IP Address:", ipAddress);
  if (!ipAddress) return null;
  const country = h.get("x-vercel-ip-country") || (await getCountry(ipAddress));
  console.log("Country:", country);
  if (!country) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currency = (countryToCurrency as any)[country];
  console.log("Currency:", currency);
  return currency;
}
