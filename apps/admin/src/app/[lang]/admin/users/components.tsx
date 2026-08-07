"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Input } from "@beutl/ui/ui/input";
import { Button } from "@beutl/ui/ui/button";
import { Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function UserSearchForm({ lang, query }: { lang: string; query?: string }) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(query || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (value) {
      params.set("q", value);
    } else {
      params.delete("q");
    }
    params.delete("page");
    router.push(`/${lang}/admin/users?${params.toString()}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("admin:users.searchPlaceholder")}
        className="max-w-sm"
      />
      <Button type="submit" variant="outline">
        <Search className="mr-2 h-4 w-4" />
        {t("admin:users.search")}
      </Button>
    </form>
  );
}
