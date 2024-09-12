"use client":

import { useActionState } from "react";
import { signInWithEmail } from "./actions";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

export default function SignInForm({ returnUrl }: { returnUrl: string }) {
  const [state, dispatch] = useActionState(signInWithEmail, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>サインイン</CardTitle>
        <CardDescription>お使いのアカウントを使用</CardDescription>
      </CardHeader>
      <CardContent>
        {/* <form id="signin-form" action={dispatch}>
          <div className="grid w-full items-center gap-4">
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="email">メールアドレス</Label>
              <Input name="email" id="email" placeholder="me@example.com" />
            </div>
          </div>
          <input type="hidden" name="returnUrl" value={returnUrl} />
        </form> */}
        <Form>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
            <FormField
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input placeholder="shadcn" {...field} />
                  </FormControl>
                  <FormDescription>
                    This is your public display name.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit">Submit</Button>
          </form>
        </Form>
      </CardContent>
      <CardFooter className="block">
        <Button className="w-full" form="signin-form" type="submit">サインイン</Button>
        <Link href="/account/sign-up" className="text-sm font-medium inline-block mt-6">アカウント作成</Link>
      </CardFooter>
    </Card>
  )
}