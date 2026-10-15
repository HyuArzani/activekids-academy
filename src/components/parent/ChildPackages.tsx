"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useContextFetch, type FetchState } from "@/lib/parent-ui/useContextFetch";
import { FetchStateView } from "./FetchStateView";
import { formatDate, entitlementStatusLabel } from "@/lib/parent-ui/format";

interface Entitlement {
  id: string;
  sequence: number;
  status: string;
  skipUsed: boolean;
  originalOccurrenceId: string | null;
  assignedOccurrenceId: string | null;
}

interface PackageEntry {
  packageId: string;
  packageName: string;
  sessionCount: number;
  packageStatus: string;
  purchasedAt: string;
  entitlements: Entitlement[];
}

interface PackagesResponse { packages: PackageEntry[] }

export function ChildPackages({
  studentId,
  academyId,
  onSessionExpired,
}: {
  studentId: string;
  academyId: string;
  onSessionExpired: () => void;
}) {
  const urlBuilder = useMemo(
    () => (id: string) => `/api/parent/children/${id}/packages?academyId=${academyId}`,
    [academyId],
  );
  const { state, retry } = useContextFetch<PackagesResponse>(urlBuilder, studentId, { onSessionExpired });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Paket & Sesi</CardTitle>
      </CardHeader>
      <CardContent>
        <FetchStateView
          state={state as FetchState<unknown>}
          expectedContextId={studentId}
          onRetry={retry}
          emptyMessage="Belum ada paket terdaftar."
        >
          <div className="space-y-4">
            {(state.data?.packages ?? []).map((pkg) => {
              const active = pkg.entitlements.filter((e) => e.status === "active").length;
              const completed = pkg.entitlements.filter((e) => e.status === "completed").length;
              return (
                <div key={pkg.packageId} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{pkg.packageName}</p>
                      <p className="text-sm text-muted-foreground">
                        Dibeli: {formatDate(pkg.purchasedAt)}
                      </p>
                    </div>
                    <Badge variant={pkg.packageStatus === "active" ? "default" : "secondary"}>
                      {pkg.packageStatus === "active" ? "Aktif" : pkg.packageStatus}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-sm">
                    <span className="text-muted-foreground">Total: <span className="font-medium text-foreground">{pkg.sessionCount}</span></span>
                    <span className="text-muted-foreground">Aktif: <span className="font-medium text-foreground">{active}</span></span>
                    <span className="text-muted-foreground">Selesai: <span className="font-medium text-foreground">{completed}</span></span>
                  </div>
                  {/* Entitlement detail list */}
                  <div className="mt-3 space-y-1.5">
                    {pkg.entitlements.map((ent) => (
                      <div key={ent.id} className="flex items-center justify-between gap-2 text-sm py-1 border-t border-muted/50">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">#{ent.sequence}</span>
                          <Badge variant="outline" className="text-xs">{entitlementStatusLabel(ent.status)}</Badge>
                          {ent.skipUsed && <span className="text-xs text-muted-foreground">skip digunakan</span>}
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          {ent.assignedOccurrenceId ? "Terjadwal" : "Belum terjadwal"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </FetchStateView>
      </CardContent>
    </Card>
  );
}
