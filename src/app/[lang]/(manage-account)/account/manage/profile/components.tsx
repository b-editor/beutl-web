"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { InferSelectModel } from "drizzle-orm";
import type { profile, socialProfile, socialProfileProvider } from "@/drizzle/schema";

type Profile = InferSelectModel<typeof profile>;
type SocialProfile = InferSelectModel<typeof socialProfile> & {
  provider: InferSelectModel<typeof socialProfileProvider>;
};
import { AlertCircle, CheckCircle, Link2, Lock, LockOpen } from "lucide-react";
import { type ComponentProps, useMemo, useState, useActionState } from "react";
import { type State, updateProfile } from "./actions";
import SubmitButton from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErrorDisplay } from "@/components/error-display";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/app/i18n/client";

function ChangeUserName({
  profile,
  state,
  lang,
}: {
  profile: Profile | null;
  state: State;
  lang: string;
}) {
  const [locked, setLocked] = useState(true);
  const { t } = useTranslation(lang);

  return (
    <div className="rounded-lg border text-card-foreground flex flex-col">
      <Label className="font-bold text-md m-6 mb-4" htmlFor="userName">
        {t("account:profile.userId")}
      </Label>
      <Separator />
      <div className="flex gap-2 mx-6 mt-4">
        <Input
          className="max-w-sm"
          type="text"
          id="userName"
          name="userName"
          defaultValue={profile?.userName}
          readOnly={locked}
        />

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className={locked ? "" : "pointer-events-none select-none"}
            >
              {locked ? (
                <Lock className="w-4 h-4" />
              ) : (
                <LockOpen className="w-4 h-4" />
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("account:profile.userIdDialog.title")}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-foreground">
                <p>{t("account:profile.userIdDialog.p1")}</p>
                <p>{t("account:profile.userIdDialog.p2")}</p>
                <ul className="list-disc list-inside ml-4 mt-2">
                  <li>{t("account:profile.userIdDialog.li1")}</li>
                  <li>{t("account:profile.userIdDialog.li2")}</li>
                  <li>{t("account:profile.userIdDialog.li3")}</li>
                </ul>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => setLocked(false)}>
                {t("continue")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="text-sm text-muted-foreground m-6 mt-2">
        {t("account:profile.userIdDescription")}
      </p>
      {state.errors?.userName && (
        <ErrorDisplay
          className="mx-6 mb-6 -mt-2"
          errors={state.errors.userName}
        />
      )}
    </div>
  );
}

type FormProps = ComponentProps<"form"> & {
  profile: Profile | null;
  socials: SocialProfile[];
};

export function Form({
  profile,
  socials,
  lang,
  ...props
}: FormProps & { lang: string }) {
  const xProfile = useMemo(
    () => socials.find((social) => social.provider.provider === "x"),
    [socials],
  );
  const ghProfile = useMemo(
    () => socials.find((social) => social.provider.provider === "github"),
    [socials],
  );
  const ytProfile = useMemo(
    () => socials.find((social) => social.provider.provider === "youtube"),
    [socials],
  );
  const customProfile = useMemo(
    () => socials.find((social) => social.provider.provider === "custom"),
    [socials],
  );
  const [state, dispatch] = useActionState(updateProfile, {});
  const { t } = useTranslation(lang);

  return (
    <form {...props} action={dispatch}>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border text-card-foreground flex flex-col">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="displayName">
            {t("account:profile.displayName")}
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="text"
            id="displayName"
            name="displayName"
            defaultValue={profile?.displayName}
            maxLength={50}
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("account:profile.maxCharacters", { max: 50 })}
          </p>
          {state.errors?.displayName && (
            <ErrorDisplay
              className="mx-6 mb-6 -mt-2"
              errors={state.errors.displayName}
            />
          )}
        </div>
        <ChangeUserName profile={profile} state={state} lang={lang} />
        <div className="rounded-lg border text-card-foreground flex flex-col">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="bio">
            {t("account:profile.bio")}
          </Label>
          <Separator />
          <Textarea
            className="max-w-sm w-auto mt-4 mx-6"
            id="bio"
            name="bio"
            defaultValue={profile?.bio || undefined}
            maxLength={150}
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("account:profile.bioDescription")}
          </p>
          {state.errors?.bio && (
            <ErrorDisplay
              className="mx-6 mb-6 -mt-2"
              errors={state.errors.bio}
            />
          )}
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col">
          <h3 className="font-bold text-md m-6 mb-4">
            {t("account:profile.socials")}
          </h3>
          <Separator />
          <div className="mx-6 mt-4 my-2">
            <div className="flex gap-4 max-w-xs items-center">
              <svg
                className="flex-1 max-w-5 invert"
                role="img"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <title>X</title>
                <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
              </svg>
              <Input
                className="flex-1"
                type="text"
                name="x"
                defaultValue={xProfile?.value}
                placeholder="@X"
              />
            </div>
            {state.errors?.x && (
              <ErrorDisplay className="ml-9 mt-1" errors={state.errors.x} />
            )}
          </div>
          <div className="mx-6 my-2">
            <div className="flex gap-4 max-w-xs items-center">
              <svg
                className="flex-1 max-w-5 invert"
                role="img"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <title>GitHub</title>
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              <Input
                className="flex-1"
                type="text"
                name="github"
                defaultValue={ghProfile?.value}
                placeholder="octokit"
              />
            </div>
            {state.errors?.github && (
              <ErrorDisplay
                className="ml-9 mt-1"
                errors={state.errors.github}
              />
            )}
          </div>
          <div className="mx-6 my-2">
            <div className="flex gap-4 max-w-xs items-center">
              <svg
                className="flex-1 max-w-5 invert"
                role="img"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <title>YouTube</title>
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
              <Input
                className="flex-1"
                type="text"
                name="youtube"
                defaultValue={ytProfile?.value}
                placeholder="@YouTube"
              />
            </div>
            {state.errors?.youtube && (
              <ErrorDisplay
                className="ml-9 mt-1"
                errors={state.errors.youtube}
              />
            )}
          </div>
          <div className="mx-6 my-2 mb-6">
            <div className="flex gap-4 max-w-xs items-center">
              <Link2 className="flex-1 max-w-5" />
              <Input
                className="flex-1"
                type="text"
                name="custom"
                defaultValue={customProfile?.value}
                placeholder="https://example.com"
              />
            </div>
            {state.errors?.custom && (
              <ErrorDisplay
                className="ml-9 mt-1"
                errors={state.errors.custom}
              />
            )}
          </div>
        </div>

        {state.message && (
          <Alert variant={!state.success ? "destructive" : "default"}>
            {!state.success ? (
              <AlertCircle className="h-4 w-4" />
            ) : (
              <CheckCircle className="h-4 w-4" />
            )}
            <AlertTitle>
              {!state.success ? t("error") : t("success")}
            </AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex gap-4 my-6">
          <SubmitButton>{t("save")}</SubmitButton>
          <Button variant="outline" type="reset">
            {t("discardChanges")}
          </Button>
        </div>
      </div>
    </form>
  );
}
