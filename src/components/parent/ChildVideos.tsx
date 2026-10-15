"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useContextFetch, type FetchState } from "@/lib/parent-ui/useContextFetch";
import { FetchStateView } from "./FetchStateView";
import { formatDate, extractYouTubeId } from "@/lib/parent-ui/format";

interface VideoRow {
  id: string;
  studentId: string;
  uploadedBy: string;
  title: string;
  youtubeUrl: string;
  videoId: string;
  trainingDate: string | null;
  category: string | null;
  notes: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VideosResponse { videos: VideoRow[] }

export function ChildVideos({
  studentId,
  academyId,
  onSessionExpired,
}: {
  studentId: string;
  academyId: string;
  onSessionExpired: () => void;
}) {
  const urlBuilder = useMemo(
    () => (id: string) => `/api/parent/students/${id}/videos?academyId=${academyId}`,
    [academyId],
  );
  const { state, retry } = useContextFetch<VideosResponse>(urlBuilder, studentId, { onSessionExpired });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Video Latihan</CardTitle>
      </CardHeader>
      <CardContent>
        <FetchStateView
          state={state as FetchState<unknown>}
          expectedContextId={studentId}
          onRetry={retry}
          emptyMessage="Belum ada video latihan tersedia."
        >
          <div className="space-y-4">
            {(state.data?.videos ?? []).map((v) => (
              <div key={v.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{v.title}</p>
                    {v.trainingDate && (
                      <p className="text-xs text-muted-foreground">Latihan: {formatDate(v.trainingDate)}</p>
                    )}
                  </div>
                  {v.category && <Badge variant="outline">{v.category}</Badge>}
                </div>
                {v.notes && <p className="text-xs text-muted-foreground mb-2">{v.notes}</p>}
                {/*
                 * Safe YouTube embed: extract the video ID from the validated
                 * youtubeUrl (the backend's CHECK constraint guarantees a valid
                 * YouTube URL). We construct the embed URL from the extracted
                 * videoId only — never from the raw youtubeUrl — preventing
                 * arbitrary iframe sources from untrusted input.
                 */}
                {(() => {
                  const vid = extractYouTubeId(v.youtubeUrl);
                  return vid && (
                    <div className="aspect-video w-full overflow-hidden rounded-md">
                      <iframe
                        className="h-full w-full"
                        src={`https://www.youtube.com/embed/${vid}`}
                        title={v.title}
                        frameBorder="0"
                        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </FetchStateView>
      </CardContent>
    </Card>
  );
}
