import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignupFlow } from "@/components/signup-flow";
import { getSessionUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign up" };

export default async function SignupPage() {
  if (await getSessionUser()) redirect("/");
  return <SignupFlow />;
}
