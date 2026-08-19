"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./ui/button";
import { Loader2 } from "lucide-react";
import { ComponentProps } from "react";

// `forceSpinner` is how a form says "I am busy" when useFormStatus cannot say it
// for us. A form whose action is a useActionState dispatch is one such case: the
// dispatch returns as soon as it has queued the work, so the form's own status
// goes back to idle within the same tick while the action is still running.
// Pass the `isPending` that useActionState returns.
export default function SubmitButton({
  showSpinner,
  forceSpinner,
  ...props
}: ComponentProps<typeof Button> & { showSpinner?: boolean; forceSpinner?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button
      {...props}
      type={props.type ?? "submit"}
      disabled={pending || props.disabled}
    >
      {(pending || forceSpinner) && showSpinner !== false && (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      )}
      {props.children}
    </Button>
  );
}
