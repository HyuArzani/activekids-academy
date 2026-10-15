"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useContextFetch, type FetchState } from "@/lib/parent-ui/useContextFetch";
import { FetchStateView } from "./FetchStateView";
import { formatDate } from "@/lib/parent-ui/format";

interface ReportEntry {
  id: string;
  semesterName: string;
  semesterStartDate: string;
  semesterEndDate: string;
  body: string;
  publishedAt: string;
}

interface ReportsResponse { reports: ReportEntry[] }

export function ChildReports({
  studentId,
  academyId,
  onSessionExpired,
}: {
  studentId: string;
  academyId: string;
  onSessionExpired: () => void;
}) {
  const urlBuilder = useMemo(
    () => (id: string) => `/api/parent/children/${id}/reports?academyId=${academyId}`,
    [academyId],
  );
  const { state, retry } = useContextFetch<ReportsResponse>(urlBuilder, studentId, { onSessionExpired });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Laporan Semester</CardTitle>
      </CardHeader>
      <CardContent>
        <FetchStateView
          state={state as FetchState<unknown>}
          expectedContextId={studentId}
          onRetry={retry}
          emptyMessage="Belum ada laporan yang dipublikasikan."
        >
          <div className="space-y-4">
            {(state.data?.reports ?? []).map((r) => (
              <div key={r.id} className="rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div>
                    <p className="font-medium">{r.semesterName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(r.semesterStartDate)} – {formatDate(r.semesterEndDate)}
                    </p>
                  </div>
                  <Badge variant="secondary">Dipublikasikan {formatDate(r.publishedAt)}</Badge>
                </div>
                {/*
                 * Render the report body as plain text (pre-formatted).
                 * Do NOT render as HTML/trusted markup — the backend stores
                 * body as text, and we must not inject untrusted HTML.
                 */}
                <pre className="whitespace-pre-wrap text-sm text-foreground/90 font-sans leading-relaxed">
                  {r.body}
                </pre>
              </div>
            ))}
          </div>
        </FetchStateView>
      </CardContent>
    </Card>
  );
}
