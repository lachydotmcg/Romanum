import { redirect } from "next/navigation";

export default function NewProjectPage() {
  redirect("/chats?onboarding=true");
}
