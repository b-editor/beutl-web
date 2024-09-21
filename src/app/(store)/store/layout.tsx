import { Navigation } from "@/app/components";
import { auth } from "@/auth";
import NavBar from "@/components/nav-bar";
import { Button } from "@/components/ui/button";
import { UserCircle } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <NavBar />
      {children}
    </div>
  )
}