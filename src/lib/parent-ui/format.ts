/**
 * Date/time formatting utilities for the Parent Portal UI.
 * Academy timezone: Asia/Jakarta. Indonesian locale for display.
 * Pure functions safe for client use.
 */

/** Format an ISO date string (YYYY-MM-DD) as a readable Indonesian date. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + (iso.includes("T") ? "" : "T00:00:00Z"));
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** Format an ISO datetime string (with timezone) as date + time in Asia/Jakarta. */
export function formatDateTime(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "—", time: "" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "—", time: "" };
  return {
    date: new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Jakarta",
    }).format(d),
    time: new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(d),
  };
}

/** Check if an ISO datetime is in the past. */
export function isPastSession(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

/** Map a moveType to a human-readable Indonesian label + badge variant. */
export function moveTypeLabel(moveType: string): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  switch (moveType) {
    case "original":
      return { label: "Terjadwal", variant: "default" };
    case "moved":
      return { label: "Dipindahkan", variant: "secondary" };
    case "makeup":
      return { label: "Makeup", variant: "secondary" };
    case "skipped":
      return { label: "Dilewati", variant: "destructive" };
    case "cancelled":
      return { label: "Dibatalkan", variant: "destructive" };
    case "excused_absence":
      return { label: "Izin", variant: "outline" };
    case "awaiting_makeup":
      return { label: "Menunggu Makeup", variant: "outline" };
    case "unassigned":
      return { label: "Belum Terjadwal", variant: "outline" };
    case "completed":
      return { label: "Selesai", variant: "secondary" };
    case "admin_corrected":
      return { label: "Dikoreksi Admin", variant: "secondary" };
    case "initial_assignment":
      return { label: "Penetapan Awal", variant: "default" };
    default:
      return { label: moveType, variant: "outline" };
  }
}

/** Map an attendance status to a human-readable Indonesian label + badge variant. */
export function attendanceLabel(status: string): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  switch (status) {
    case "present":
      return { label: "Hadir", variant: "default" };
    case "absent":
      return { label: "Tidak Hadir", variant: "destructive" };
    case "excused":
      return { label: "Izin", variant: "outline" };
    case "late":
      return { label: "Terlambat", variant: "secondary" };
    default:
      return { label: status, variant: "outline" };
  }
}

/** Map an entitlement status to a human-readable Indonesian label. */
export function entitlementStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "skipped":
      return "Dilewati";
    case "awaiting_makeup":
      return "Menunggu Makeup";
    case "completed":
      return "Selesai";
    case "cancelled":
      return "Dibatalkan";
    default:
      return status;
  }
}

/**
 * Extract a YouTube video ID from a validated YouTube URL.
 * Mirrors the backend's `extractVideoId` in student-videos.ts.
 * The backend's CHECK constraint guarantees the stored URL is a valid
 * YouTube URL (https://youtube.com/watch?v=ID or https://youtu.be/ID).
 * This is defense-in-depth — the security boundary is the backend's
 * validation at INSERT time, not this client-side extraction.
 */
export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      return id.length === 11 ? id : null;
    }
    if (u.hostname === "youtube.com" || u.hostname === "www.youtube.com") {
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        return v && v.length === 11 ? v : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
