import { redirect } from "next/navigation";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  redirect((await searchParams).archived === "true" ? "/chats?archived=true" : "/chats");
}
