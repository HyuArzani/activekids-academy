"use client";

import { useMemo, useState } from "react";
import { SkipForward, Move, CalendarPlus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useContextFetch } from "@/lib/parent-ui/useContextFetch";
import { FetchStateView } from "./FetchStateView";
import { formatDateTime, isPastSession, moveTypeLabel } from "@/lib/parent-ui/format";
import type { FetchState } from "@/lib/parent-ui/useContextFetch";
import { SkipActionDialog } from "./SkipActionDialog";
import { MoveActionDialog } from "./MoveActionDialog";
import { MakeupActionDialog } from "./MakeupActionDialog";

interface ScheduleEntry {
  entitlementId: string;
  sequence: number;
  status: string;
  moveType: string;
  occurrenceId: string | null;
  occurrenceDate: string | null;
  startAt: string | null;
  className: string | null;
  attendanceStatus: string | null;
  originalOccurrenceId: string | null;
  originalOccurrenceDate: string | null;
  originalStartAt: string | null;
  wasMoved: boolean;
}

interface ScheduleResponse { schedule: ScheduleEntry[] }

export function ChildSchedule({
  studentId,
  academyId,
  onSessionExpired,
}: {
  studentId: string;
  academyId: string;
  onSessionExpired: () => void;
}) {
  const urlBuilder = useMemo(
    () => (id: string) => `/api/parent/children/${id}/schedule?academyId=${academyId}`,
    [academyId],
  );
  const { state, retry } = useContextFetch<ScheduleResponse>(urlBuilder, studentId, { onSessionExpired });

  // Skip dialog state — which entitlement is being skipped, plus a nonce
  // that increments each time the dialog opens (forces remount → fresh
  // idempotency key for each new action).
  const [skipTarget, setSkipTarget] = useState<ScheduleEntry | null>(null);
  const [skipNonce, setSkipNonce] = useState(0);
  // Move dialog state — same pattern as skip.
  const [moveTarget, setMoveTarget] = useState<ScheduleEntry | null>(null);
  const [moveNonce, setMoveNonce] = useState(0);
  // Makeup dialog state — same pattern as skip/move.
  const [makeupTarget, setMakeupTarget] = useState<ScheduleEntry | null>(null);
  const [makeupNonce, setMakeupNonce] = useState(0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Jadwal Latihan</CardTitle>
      </CardHeader>
      <CardContent>
        <FetchStateView
          state={state as FetchState<unknown>}
          expectedContextId={studentId}
          onRetry={retry}
          emptyMessage="Belum ada jadwal latihan."
        >
          <div className="space-y-3">
            {(state.data?.schedule ?? []).map((entry) => {
              const dt = formatDateTime(entry.startAt);
              const past = isPastSession(entry.startAt);
              const mt = moveTypeLabel(entry.moveType);
              const origDt = entry.originalOccurrenceDate ? formatDateTime(entry.originalStartAt) : null;
              // Skip/Move eligibility: active status, has a current assignment, future session.
              // Based on authoritative fields from the API (status, occurrenceId, startAt).
              const canSkip =
                entry.status === "active" &&
                entry.occurrenceId !== null &&
                !past;
              // Makeup eligibility: entitlement is skipped or awaiting makeup
              // (per the actual backend contract — assignMakeupCore accepts
              // status IN ('skipped', 'awaiting_makeup')). A dedicated predicate;
              // NOT the same as canSkip or canMove.
              const canMakeup =
                entry.status === "skipped" ||
                entry.status === "awaiting_makeup";
              return (
                <div
                  key={entry.entitlementId}
                  className={`rounded-lg border p-3 ${past ? "opacity-60" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {dt.date} {dt.time && <span className="text-muted-foreground">{dt.time}</span>}
                      </p>
                      <p className="text-sm text-muted-foreground">{entry.className ?? "—"}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant={mt.variant}>{mt.label}</Badge>
                      {past && <span className="text-xs text-muted-foreground">Selesai</span>}
                    </div>
                  </div>
                  {entry.wasMoved && origDt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Jadwal awal: {origDt.date} {origDt.time}
                    </p>
                  )}
                  {entry.attendanceStatus && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Kehadiran: {entry.attendanceStatus}
                    </p>
                  )}
                  {/* Move + Skip actions — only for eligible future active entitlements */}
                  {canSkip && (
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() => { setMoveTarget(entry); setMoveNonce((n) => n + 1); }}
                      >
                        <Move className="h-4 w-4" aria-hidden /> Pindahkan
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() => { setSkipTarget(entry); setSkipNonce((n) => n + 1); }}
                      >
                        <SkipForward className="h-4 w-4" aria-hidden /> Lewati
                      </Button>
                    </div>
                  )}
                  {/* Makeup action — only for skipped/awaiting-makeup entitlements.
                      Separate from Move/Skip (different eligibility: status must be
                      'skipped' or 'awaiting_makeup', NOT 'active'). */}
                  {canMakeup && (
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() => { setMakeupTarget(entry); setMakeupNonce((n) => n + 1); }}
                      >
                        <CalendarPlus className="h-4 w-4" aria-hidden /> Jadwalkan Makeup
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Menampilkan 30 sesi terbaru.</p>
        </FetchStateView>
      </CardContent>

      {/* Skip dialog — rendered at the card level so it overlays the schedule.
          key={skipNonce} forces a remount each time the Skip button is clicked,
          generating a fresh idempotency key for each new action. */}
      {skipTarget && (
        <SkipActionDialog
          key={skipNonce}
          open={skipTarget !== null}
          onClose={() => setSkipTarget(null)}
          entitlementId={skipTarget.entitlementId}
          studentId={studentId}
          academyId={academyId}
          occurrenceDate={skipTarget.occurrenceDate}
          startAt={skipTarget.startAt}
          className={skipTarget.className}
          onSessionExpired={onSessionExpired}
          onSuccess={retry}
        />
      )}

      {/* Move dialog — same remount pattern as skip for fresh idempotency key. */}
      {moveTarget && (
        <MoveActionDialog
          key={moveNonce}
          open={moveTarget !== null}
          onClose={() => setMoveTarget(null)}
          entitlementId={moveTarget.entitlementId}
          studentId={studentId}
          academyId={academyId}
          expectedCurrentOccurrenceId={moveTarget.occurrenceId!}
          occurrenceDate={moveTarget.occurrenceDate}
          startAt={moveTarget.startAt}
          className={moveTarget.className}
          onSessionExpired={onSessionExpired}
          onSuccess={retry}
        />
      )}

      {/* Makeup dialog — same remount pattern as skip/move for fresh idempotency key. */}
      {makeupTarget && (
        <MakeupActionDialog
          key={makeupNonce}
          open={makeupTarget !== null}
          onClose={() => setMakeupTarget(null)}
          entitlementId={makeupTarget.entitlementId}
          studentId={studentId}
          academyId={academyId}
          entitlementStatus={makeupTarget.status}
          moveType={makeupTarget.moveType}
          originalOccurrenceDate={makeupTarget.originalOccurrenceDate}
          originalStartAt={makeupTarget.originalStartAt}
          className={makeupTarget.className}
          onSessionExpired={onSessionExpired}
          onSuccess={retry}
        />
      )}
    </Card>
  );
}
