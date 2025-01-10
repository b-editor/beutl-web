"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./ui/button";
import { Loader2 } from "lucide-react";

export default function SubmitButton({
  showSpinner,
  forceSpinner,
  ...props
}: ButtonProps & { showSpinner?: boolean; forceSpinner?: boolean }) {
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
