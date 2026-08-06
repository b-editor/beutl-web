import Image from "next/image";

export function AuthLogo() {
  return (
    <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
      <Image
        width={40}
        height={40}
        className="w-10 h-10 align-bottom"
        src="/img/logo_dark.svg"
        alt="Logo"
      />
      <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
    </div>
  );
}
