import { AuthShell } from "@/components/auth/AuthShell";

// Server component — renders the client-side auth shell. The shell fetches
// /api/auth/session on mount to determine the initial view (login form,
// change-password form, or logged-in view). All real authorization happens
// in the API route handlers, not in the UI.

export default function Home() {
  return <AuthShell />;
}
