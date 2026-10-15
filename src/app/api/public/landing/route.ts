/**
 * GET /api/public/landing?academyId=X
 *
 * Returns the PUBLISHED landing page content for an academy. Unauthenticated.
 * Draft content is NEVER returned by this endpoint.
 *
 * The academyId is the public identifier — it's a UUID, not a secret.
 * Cross-academy access is fine (the published content is public).
 */
import { type NextRequest, NextResponse } from "next/server";
import { getPublishedLandingPage } from "@/lib/domain/cms";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const academyId = request.nextUrl.searchParams.get("academyId");
  if (!academyId || academyId.trim() === "") {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "academyId query parameter is required" } },
      { status: 422 },
    );
  }
  try {
    const page = await getPublishedLandingPage(academyId, getDb());
    return NextResponse.json(page);
  } catch (err) {
    // Safe error mapping — never leaks DB/stack details.
    const isNotFound = err instanceof Error && "code" in err && (err as { code: string }).code === "NOT_FOUND";
    const status = isNotFound ? 404 : 500;
    const message = isNotFound
      ? "No published landing page for this academy."
      : "Failed to load landing page.";
    return NextResponse.json(
      { error: { code: isNotFound ? "NOT_FOUND" : "UPSTREAM_ERROR", message } },
      { status },
    );
  }
}
