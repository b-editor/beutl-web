"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./ui/button";
import { Loader2 } from "lucide-react";
import { ComponentProps } from "react";

export default function SubmitButton({
  showSpinner,
  forceSpinner,
  ...props
}: ComponentProps<typeof Button> & { showSpinner?: boolean; forceSpinner?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button {...props} type="submit" disabled={pending || props.disabled}>
      {(pending || forceSpinner) && showSpinner !== false && (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      )}
      {props.children}
    </Button>
  );
}
