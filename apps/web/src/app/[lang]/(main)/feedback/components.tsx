"use client";

import { type ComponentProps, useActionState, useState } from "react";
import { submitFeedback } from "./actions";
import { useTranslation } from "@/app/i18n/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, CheckCircle } from "lucide-react";
import SubmitButton from "@/components/submit-button";
import { ErrorDisplay } from "@/components/error-display";

type FeedbackFormProps = ComponentProps<"form"> & {
  lang: string;
  defaultName: string;
  defaultEmail: string;
  traceId?: string;
};

const categories = [
  "BUG_REPORT",
  "FEATURE_REQUEST",
  "QUESTION",
  "OTHER",
] as const;

export function FeedbackForm({
  lang,
  defaultName,
  defaultEmail,
  traceId,
  ...props
}: FeedbackFormProps) {
  const [state, dispatch] = useActionState(submitFeedback, {});
  const { t } = useTranslation(lang);
  const [category, setCategory] = useState("");

  return (
    <form {...props} action={dispatch}>
      <div className="flex flex-col gap-4">
        {traceId && (
          <div className="rounded-lg border text-card-foreground flex flex-col">
            <Label className="font-bold text-md m-6 mb-4" htmlFor="traceId">
              {t("feedback:traceId")}
            </Label>
            <Separator />
            <Input
              className="max-w-sm w-auto mt-4 mx-6 mb-6"
              type="text"
              id="traceId"
              name="traceId"
              value={traceId}
              readOnly
            />
          </div>
        )}

        <div className="rounded-lg border text-card-foreground flex flex-col">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="name">
            {t("feedback:name")}
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="text"
            id="name"
            name="name"
            defaultValue={defaultName}
            placeholder={t("feedback:namePlaceholder")}
            maxLength={100}
          />
          <div className="h-6 mx-6 mt-2 mb-4">
            {state.errors?.name && (
              <ErrorDisplay errors={state.errors.name} />
            )}
          </div>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="email">
            {t("feedback:email")}
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="email"
            id="email"
            name="email"
            defaultValue={defaultEmail}
            placeholder={t("feedback:emailPlaceholder")}
          />
          <div className="h-6 mx-6 mt-2 mb-4">
            {state.errors?.email && (
              <ErrorDisplay errors={state.errors.email} />
            )}
          </div>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="category">
            {t("feedback:category")}
          </Label>
          <Separator />
          <div className="max-w-sm w-auto mt-4 mx-6">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder={t("feedback:categoryPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {t(`feedback:categories.${cat}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" name="category" value={category} />
          </div>
          <div className="h-6 mx-6 mt-2 mb-4">
            {state.errors?.category && (
              <ErrorDisplay errors={state.errors.category} />
            )}
          </div>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="message">
            {t("feedback:message")}
          </Label>
          <Separator />
          <Textarea
            className="max-w-lg w-auto mt-4 mx-6 min-h-[150px]"
            id="message"
            name="message"
            placeholder={t("feedback:messagePlaceholder")}
            maxLength={2000}
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("feedback:messageDescription")}
          </p>
          {state.errors?.message && (
            <ErrorDisplay
              className="mx-6 mb-6 -mt-2"
              errors={state.errors.message}
            />
          )}
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
          <SubmitButton>{t("feedback:submit")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}
