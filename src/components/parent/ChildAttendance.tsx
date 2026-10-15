"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useContextFetch, type FetchState } from "@/lib/parent-ui/useContextFetch";
import { FetchStateView } from "./FetchStateView";
import { formatDateTime, attendanceLabel } from "@/lib/parent-ui/format";

interface AttendanceEntry {
  id: string;
  occurrenceDate: string;
  startAt: string;
  className: string;
  status: string;
  notes: string | null;
}

interface AttendanceResponse { attendance: AttendanceEntry[] }

export function ChildAttendance({
  studentId,
  academyId,
  onSessionExpired,
}: {
  studentId: string;
  academyId: string;
  onSessionExpired: () => void;
}) {
  const urlBuilder = useMemo(
    () => (id: string) => `/api/parent/children/${id}/attendance?academyId=${academyId}`,
    [academyId],
  );
  const { state, retry } = useContextFetch<AttendanceResponse>(urlBuilder, studentId, { onSessionExpired });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Riwayat Kehadiran</CardTitle>
      </CardHeader>
      <CardContent>
        <FetchStateView
          state={state as FetchState<unknown>}
          expectedContextId={studentId}
          onRetry={retry}
          emptyMessage="Belum ada catatan kehadiran."
        >
          <div className="space-y-2">
            {(state.data?.attendance ?? []).map((a) => {
              const dt = formatDateTime(a.startAt);
              const al = attendanceLabel(a.status);
              return (
                <div key={a.id} className="flex items-start justify-between gap-2 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{dt.date} {dt.time}</p>
                    <p className="text-sm text-muted-foreground">{a.className}</p>
                    {a.notes && <p className="text-xs text-muted-foreground mt-1">{a.notes}</p>}
                  </div>
                  <Badge variant={al.variant}>{al.label}</Badge>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Menampilkan 50 catatan terbaru.</p>
        </FetchStateView>
      </CardContent>
    </Card>
  );
}
