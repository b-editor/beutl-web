"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./ui/button";
import { Loader2 } from "lucide-react";

export default function SubmitButton({ showSpinner, ...props }: ButtonProps & { showSpinner?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button {...props} type="submit" disabled={pending}>
      {pending && showSpinner !== false && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {props.children}
    </Button>
  );
}
