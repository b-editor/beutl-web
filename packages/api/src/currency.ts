// Worker 版通貨推測。Web 版は next/headers に依存するため、
// リクエストヘッダを直接受け取る形に置換する。
import countryToCurrency from "country-to-currency";

async function getCountry(ipAddress: string) {
  const token = process.env.IPINFO_TOKEN;
  if (!token || !ipAddress) return null;

  const res = await fetch(`https://ipinfo.io/${ipAddress}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const json = (await res.json()) as { country?: string | null };
  return json?.country || null;
}

export async function guessCurrency(
  request?: Request,
): Promise<string | null> {
  if (process.env.NODE_ENV === "development") return "JPY";
  const ipAddress =
    request?.headers.get("x-real-ip") ||
    request?.headers.get("X-Forwarded-For")?.split(",")[0];
  if (!ipAddress) return null;
  const country =
    request?.headers.get("CF-IPCountry") || (await getCountry(ipAddress));
  if (!country) return null;
  const currency = countryToCurrency[country as keyof typeof countryToCurrency];
  return currency ?? null;
}
