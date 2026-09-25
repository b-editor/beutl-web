import { getUserSecurityOverview, USER_SECURITY_RELATION_LIMIT } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { formatTimestamp } from "@/lib/format";
import { RevokeSessionsButton } from "./components";

// サインイン手段と現在有効なセッション。乗っ取りの問い合わせで、どこから
// サインインしているかを確かめ、必要なら全て失効させるための欄。
export async function SecuritySection({
  lang,
  userId,
  isSelf,
}: {
  lang: string;
  userId: string;
  isSelf: boolean;
}) {
  const { t } = await getTranslation(lang);
  const overview = await getUserSecurityOverview({ userId });

  const sessions = overview.sessions.slice(0, USER_SECURITY_RELATION_LIMIT);
  const families = overview.refreshTokenFamilies.slice(0, USER_SECURITY_RELATION_LIMIT);
  const hasActiveFamily = families.some((family) => !family.revokedAt);
  const hasSomethingToRevoke = sessions.length > 0 || hasActiveFamily;

  return (
    <section className="flex flex-col gap-6 rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("admin:users.security.title")}</h2>
        <RevokeSessionsButton
          lang={lang}
          userId={userId}
          disabled={isSelf || !hasSomethingToRevoke}
        />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("admin:users.security.signInMethods")}</h3>
        <ul className="flex flex-wrap gap-2">
          {overview.accounts.map((account) => (
            <li key={account.id}>
              <Badge variant="outline" title={formatTimestamp(account.createdAt, lang)}>
                {account.providerId}
              </Badge>
            </li>
          ))}
          {overview.passkeys.length > 0 && (
            <li>
              <Badge variant="outline">
                {t("admin:users.security.passkeyCount", { count: overview.passkeys.length })}
              </Badge>
            </li>
          )}
          {overview.accounts.length === 0 && overview.passkeys.length === 0 && (
            <li className="text-sm text-muted-foreground">{t("admin:users.security.emailOnly")}</li>
          )}
        </ul>
      </div>

      {overview.passkeys.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("admin:users.security.passkeys")}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:users.name")}</TableHead>
                <TableHead>{t("admin:users.security.deviceType")}</TableHead>
                <TableHead>{t("admin:users.createdAt")}</TableHead>
                <TableHead>{t("admin:users.security.lastUsedAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.passkeys.map((passkey) => (
                <TableRow key={passkey.id}>
                  <TableCell>{passkey.name || "-"}</TableCell>
                  <TableCell className="text-xs">
                    {passkey.deviceType}
                    {passkey.backedUp ? ` (${t("admin:users.security.backedUp")})` : ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(passkey.createdAt, lang)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {passkey.usedAt ? formatTimestamp(passkey.usedAt, lang) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("admin:users.security.webSessions")}</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:users.security.lastActiveAt")}</TableHead>
                  <TableHead>{t("admin:auditLog.ipAddress")}</TableHead>
                  <TableHead>{t("admin:users.security.userAgent")}</TableHead>
                  <TableHead>{t("admin:users.security.expiresAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(row.updatedAt, lang)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.ipAddress || "-"}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs" title={row.userAgent ?? undefined}>
                      {row.userAgent || "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(row.expiresAt, lang)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {overview.sessions.length > USER_SECURITY_RELATION_LIMIT && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("admin:users.truncatedNotice", { count: USER_SECURITY_RELATION_LIMIT })}
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("admin:users.security.desktopSessions")}</h3>
        {families.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:users.security.signedInAt")}</TableHead>
                <TableHead>{t("admin:users.security.expiresAt")}</TableHead>
                <TableHead>{t("admin:feedback.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {families.map((family) => (
                <TableRow key={family.id}>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(family.createdAt, lang)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(family.expiresAt, lang)}
                  </TableCell>
                  <TableCell>
                    {family.revokedAt ? (
                      <Badge variant="secondary">
                        {t("admin:users.security.revokedAt", {
                          date: formatTimestamp(family.revokedAt, lang),
                        })}
                      </Badge>
                    ) : (
                      <Badge>{t("admin:users.security.active")}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {overview.refreshTokenFamilies.length > USER_SECURITY_RELATION_LIMIT && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("admin:users.truncatedNotice", { count: USER_SECURITY_RELATION_LIMIT })}
          </p>
        )}
      </div>
    </section>
  );
}
