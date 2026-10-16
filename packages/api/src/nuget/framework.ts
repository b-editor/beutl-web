// NuGetFrameworkFactory and DefaultFrameworkMappings distinguish short TFMs
// from comma-separated FrameworkName values (which may use custom identifiers).
const identifiers = new Set([
  ".netcoreapp", "netcoreapp", ".netstandardapp", "netstandardapp", ".netstandard", "netstandard",
  ".netplatform", "dotnet", ".netframework", "netframework", ".net", "net", ".netmicroframework", "netmf",
  ".netportable", "netportable", "portable", ".netcore", "netcore", "silverlight", "sl", "windowsphone", "wp",
  "windowsphoneapp", "wpa", "windows", "win", "asp.net", "aspnet", "asp.netcore", "aspnetcore", "native",
  "monoandroid", "monotouch", "monomac", "xamarin.ios", "xamarinios", "xamarin.mac", "xamarinmac",
  "xamarin.playstationthree", "xamarinplaystationthree", "xamarinpsthree", "xamarin.playstationfour",
  "xamarinplaystationfour", "xamarinpsfour", "xamarin.playstationvita", "xamarinplaystationvita", "xamarinpsvita",
  "xamarin.watchos", "xamarinwatchos", "xamarin.tvos", "xamarintvos", "xamarinxboxthreesixty", "xamarin.xboxone",
  "xamarinxboxone", "dnx", "dnxcore", "winrt", "uap", "tizen", ".netnanoframework", "netnano",
]);
const net = new Set(["net", ".net", "netframework", ".netframework"]);
const core = new Set(["netcoreapp", ".netcoreapp"]);
const portable = new Set(["portable", "netportable", ".netportable"]);

function systemVersion(value: string): boolean {
  const parts = value.split(".");
  return parts.length >= 2 && parts.length <= 4 && parts.every((part) =>
    /^[+-]?\d+$/u.test(part.trim()) && Number(part) >= 0 && Number(part) <= 2147483647);
}

// null means unsupported; otherwise the boolean is NuGetFramework.HasProfile.
// Portable profiles reject member frameworks that themselves have profiles.
function frameworkProfile(value: string): boolean | null {
  if (value.includes(",")) {
    const parts = value.split(",").filter(Boolean).map((part) => part.trim());
    const identifier = parts[0]?.toLowerCase();
    if (!identifier || identifier === "unsupported") return null;
    if (identifier === "any" || identifier === "agnostic") return false;
    const attribute = (name: string) => {
      const matches = parts.filter((part) => part.toLowerCase().startsWith(`${name}=`));
      return matches.length === 1 ? matches[0].split("=")[1] : undefined;
    };
    let version = attribute("version")?.replace(/^v+/u, "") ?? "0.0";
    if (!version.includes(".")) version += ".0";
    if (!systemVersion(version)) return null;
    const profile = attribute("profile") ?? "";
    if (portable.has(identifier) && profile.includes("-")) return null;
    return core.has(identifier) && Number(version.split(".")[0]) >= 5 ? false : profile.length > 0;
  }
  try { value = decodeURIComponent(value); }
  catch {
    // An invalid encoded TFM is not a supported framework name.
    return null;
  }
  value = value.toLowerCase();
  if (value === "any" || value === "agnostic" || /^(45|4\.5|40|4\.0|4|35|3\.5|20|2\.0|2)$/u.test(value)) return false;
  const match = /^([a-z.]+)([\d.]*)(?:-([a-z\d.+-]+))?$/u.exec(value);
  if (!match || !identifiers.has(match[1])) return null;
  const [, identifier, rawVersion, profile = ""] = match;
  const version = !rawVersion ? "0.0" : rawVersion.includes(".") ? rawVersion : [...rawVersion.slice(0, 4).padEnd(2, "0")].join(".");
  if (!systemVersion(version)) return null;
  if ((net.has(identifier) || core.has(identifier)) && Number(version.split(".")[0]) >= 5) {
    const platformVersion = /^[a-z.]+(.*)$/u.exec(profile)?.[1];
    return !platformVersion || systemVersion(platformVersion.includes(".") ? platformVersion : `${platformVersion}.0`) ? false : null;
  }
  if (portable.has(identifier)) {
    const members = profile.split("+").filter(Boolean);
    return members.length && !members.some((member) => frameworkProfile(member) === true) ? true : null;
  }
  return !!profile && !(net.has(identifier) && profile === "full");
}

export function isValidNugetTargetFramework(value: string): boolean {
  return value.length <= 256 && frameworkProfile(value.trim()) !== null;
}
