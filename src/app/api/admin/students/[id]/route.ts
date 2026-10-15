/**
 * GET /api/admin/students/:id — get a single student (academy-scoped).
 * PATCH /api/admin/students/:id — update a student (academy-scoped).
 *
 * Query: ?academyId=<uuid> (required — validated against the principal's
 *   admin membership).
 *
 * PATCH body: { fullName?, dateOfBirth?, gender?, notes?, archivedAt? }
 *
 * Authorization: admin role in the specified academy. CSRF required for PATCH.
 * Cross-academy: the studentId is loaded with academy_id filter; a valid
 *   UUID from another academy → 404 NOT_FOUND (not 403 — no info leak).
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiRequest, parseBody, getAcademyIdFromQuery } from "@/lib/api/handler";
import { getStudent, updateStudent, formatDateOfBirth } from "@/lib/domain/students";

const updateSchema = z.object({
  fullName: z.string().min(1).optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  gender: z.enum(["male", "female", "unspecified"]).nullable().optional(),
  notes: z.string().nullable().optional(),
  archivedAt: z.boolean().optional(),
}).refine((obj) => Object.keys(obj).length > 0, { message: "At least one field must be provided" });

// UUID validation — rejects non-UUID path params with 422, not 500.
const uuidSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  // Validate the :id is a UUID before hitting the database.
  const uuidCheck = uuidSchema.safeParse(id);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } },
      { status: 422 },
    );
  }

  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId },
    async (principal) => {
      const student = await getStudent(principal, academyId, id);
      return NextResponse.json({
        id: student.id,
        academyId: student.academy_id,
        fullName: student.full_name,
        dateOfBirth: formatDateOfBirth(student.date_of_birth),
        gender: student.gender,
        notes: student.notes,
        archivedAt: student.archived_at ? student.archived_at.toISOString() : null,
      });
    },
  );
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  // Validate the :id is a UUID before hitting the database.
  const uuidCheck = uuidSchema.safeParse(id);
  if (!uuidCheck.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid student ID format" } },
      { status: 422 },
    );
  }

  const academyId = getAcademyIdFromQuery(request);
  return handleApiRequest(
    request,
    { role: "admin", academyId, requireCsrf: true },
    async (principal) => {
      const body = await parseBody(request, updateSchema);
      if (body instanceof NextResponse) return body;
      const result = await updateStudent(principal, academyId, id, body);
      return NextResponse.json(result);
    },
  );
}
