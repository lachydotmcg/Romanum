import type { Metadata } from "next";
import { readAccount } from "@/lib/accounts/session";
import { ProjectEditor } from "@/components/projects/project-editor";
import { ProjectSignIn } from "@/components/projects/project-sign-in";

export const metadata: Metadata = { title: "New project" };
export const dynamic = "force-dynamic";
export default async function NewProjectPage() {
  return await readAccount() ? <ProjectEditor initial={null} /> : <ProjectSignIn />;
}
