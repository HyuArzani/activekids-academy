import { AuthShell } from "@/components/auth/AuthShell";

export default async function DomainPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  return (
    <AuthShell
      mode="public"
      initialPublicView={view === "register" ? "registerForm" : "landing"}
    />
  );
}
