import { AuthShell } from "@/components/auth/AuthShell";

export default async function DomainPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; academyId?: string }>;
}) {
  const { view, academyId } = await searchParams;
  return (
    <AuthShell
      mode="public"
      initialPublicView={view === "register" ? "registerForm" : "landing"}
      publicAcademyId={academyId}
    />
  );
}
