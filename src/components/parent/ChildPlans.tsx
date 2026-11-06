"use client";

/**
 * ChildPlans — parent view of training plans shared by the coach.
 * Only plans the coach explicitly marked "visible to parents" appear.
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, AlertCircle, ClipboardList, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateTime } from "@/lib/parent-ui/format";

interface PlanDto {
  id: string;
  occurrenceId: string;
  occurrenceDate: string;
  className: string;
  title: string;
  content: string;
  visibleToParents: boolean;
  updatedAt: string;
}

export function ChildPlans({ studentId, academyId, onSessionExpired }: { studentId: string; academyId: string; onSessionExpired: () => void }) {
  const [plans, setPlans] = useState<PlanDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/parent/children/${studentId}/plans?academyId=${academyId}`, { credentials: "same-origin" });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlans(data.plans ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memuat rencana latihan");
    }
  }, [studentId, academyId, onSessionExpired]);

  useEffect(() => {
    setPlans(null);
    void load();
  }, [load]);

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
        </CardContent>
      </Card>
    );
  }
  if (!plans) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Memuat…
      </div>
    );
  }
  if (plans.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Belum ada rencana latihan yang dibagikan pelatih untuk anak Anda.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {plans.map((plan) => {
        const dt = formatDateTime(plan.updatedAt);
        return (
          <Card key={plan.id}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ClipboardList className="h-4 w-4" aria-hidden /> {plan.title}
                  </CardTitle>
                  <CardDescription>
                    {plan.className} · {formatDate(plan.occurrenceDate)}
                  </CardDescription>
                </div>
                <Badge variant="outline" className="gap-1">
                  <Eye className="h-3 w-3" aria-hidden /> Dibagikan pelatih
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/90">{plan.content}</pre>
              <p className="mt-2 text-xs text-muted-foreground">Diperbarui {dt.date}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
