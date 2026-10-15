/**
 * Domain: Public parent registration applications.
 *
 * Stage 7B: A public, unauthenticated workflow for prospective parents to
 * submit a registration APPLICATION. This is NOT account creation — a
 * submitted application does NOT create a student, guardian, package,
 * entitlement, occurrence, or payment. An Admin must review and approve.
 *
 * Lifecycle: pending → approved | rejected.
 *
 * Idempotency: client-supplied idempotency_key + body hash. Same key +
 * same hash → return original. Same key + different hash → 409.
 *
 * Rate limiting: reuses the existing DB-backed IP rate limiter
 * (checkRateLimit with identifier_type='ip'). The same login_attempts
 * table tracks IP-based abuse.
 *
 * Duplicate detection (approval):
 *   - Before creating a student, check if a student with the same
 *     full_name AND date_of_birth already exists in the academy.
 *   - If a duplicate is found, the approval FAILS with a clear CONFLICT
 *     (the Admin must resolve manually — either reject the application or
 *     archive the existing student first). This is the safest minimal
 *     implementation; automatic linking to an existing student is NOT
 *     done because it could silently grant access to the wrong family.
 *   - Duplicate guardian relationships (same guardian_user_id + student_id)
 *     are prevented by the existing UNIQUE constraint on
 *     guardian_student_links.
 *
 * Approval atomicity:
 *   - SERIALIZABLE tx: create student → create guardian user (if the
 *     parent_email is unique) → create guardian_student_link → set
 *     application.status='approved' + student_id. If any step fails, all
 *     roll back. The application stays 'pending'.
 *   - Idempotent: if the application is already 'approved', return the
 *     existing student_id without re-creating.
 *
 * Server-only. Never import from client code.
 */

import { createHash } from "node:crypto";
import type { DbClient, TxClient } from "@/lib/db";
import { getDb } from "@/lib/db";
import { Err } from "@/lib/errors";
import { writeAudit } from "@/lib/audit/writer";
import type { Principal } from "@/lib/auth/principal";
import { requireRole } from "@/lib/auth/principal";
import {
  checkAndRecordRegistrationRateLimit,
  REGISTRATION_NO_TRUSTED_IP_BUCKET,
  registrationRateLimitThresholds,
} from "@/lib/auth/rateLimit";
import {
  requireAcademyContext,
  newId,
} from "./helpers";
import { createStudent } from "./students";
import { createEnrollment } from "./enrollments";
import { hashPassword, paramsToJson } from "@/lib/auth/password";

// === Types ===============================================================

export interface SubmitRegistrationInput {
  academyId: string;
  parentFullName: string;
  parentPhone: string;
  parentEmail?: string;
  preferredContact?: "phone" | "email" | "whatsapp";
  childFullName: string;
  childDateOfBirth?: string; // YYYY-MM-DD
  classPreference?: string;
  preferredDay?: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface RegistrationApplicationRow {
  id: string;
  academyId: string;
  parentFullName: string;
  parentPhone: string;
  parentEmail: string | null;
  preferredContact: string | null;
  childFullName: string;
  childDateOfBirth: string | null;
  classPreference: string | null;
  preferredDay: string | null;
  notes: string | null;
  source: string;
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  studentId: string | null;
  submittedAt: string;
}

// === Public submission ==================================================

/**
 * Submit a registration application (PUBLIC — unauthenticated).
 * Creates a 'pending' application only. Does NOT create student/guardian/
 * package/entitlement/payment.
 *
 * Rate limiting: reuses checkRateLimit with the submitter's IP. The same
 * login_attempts table tracks IP-based abuse (20 attempts per 15 min).
 *
 * Idempotency: if idempotencyKey is provided, same key + same body hash
 * → return original. Same key + different hash → 409.
 *
 * The `source` is server-controlled: 'website' for direct public
 * submissions. Future Google Forms integration will use a separate
 * authenticated server-side endpoint that sets source='google_form'.
 * The public endpoint NEVER accepts a client-provided source.
 */
export async function submitRegistration(
  input: SubmitRegistrationInput,
  clientIp: string | null,
  db: DbClient = getDb(),
): Promise<{ applicationId: string; replayed: boolean }> {
  // Validate required fields.
  if (!input.academyId) throw Err.validation("Academy ID is required.");
  if (!input.parentFullName || input.parentFullName.trim() === "") {
    throw Err.validation("Parent full name is required.");
  }
  if (!input.parentPhone || input.parentPhone.trim() === "") {
    throw Err.validation("Parent phone number is required.");
  }
  if (!input.childFullName || input.childFullName.trim() === "") {
    throw Err.validation("Child full name is required.");
  }

  const bodyHash = input.idempotencyKey ? computeBodyHash(input) : null;

  // Idempotency replay check (BEFORE rate limiting — replays don't
  // consume a rate-limit slot). Fast path: if the application already
  // exists with the same body hash, return it without rate-limiting.
  if (input.idempotencyKey) {
    const existing = await db.query<{ id: string; idempotency_body_hash: string | null }>(
      `SELECT id, idempotency_body_hash
         FROM registration_applications
        WHERE academy_id = $1 AND idempotency_key = $2
        LIMIT 1;`,
      [input.academyId, input.idempotencyKey],
    );
    const existingRow = existing.rows[0] as { id: string; idempotency_body_hash: string | null } | undefined;
    if (existingRow) {
      if (existingRow.idempotency_body_hash === bodyHash) {
        return { applicationId: existingRow.id, replayed: true };
      }
      throw Err.conflict(
        "Idempotency key was already used with different request data.",
        "idempotency_key_reuse",
      );
    }
  }

  // Rate limit — ONLY for NEW (non-replay) requests.
  // Uses checkAndRecordRegistrationRateLimit (atomic INSERT + COUNT in a
  // SERIALIZABLE tx) so concurrent requests cannot all pass before any
  // records. Uses a 'reg:'-prefixed identifier so registration attempts
  // do NOT count toward login IP limits.
  //
  // Two paths, selected by the deployment-aware getClientIp():
  //
  //   1. Trusted IP available (normal path on Netlify and Caddy):
  //      Apply the per-IP cap (5 per 15 min). The identifier is the
  //      actual client IP, so distinct IPs get distinct buckets.
  //
  //   2. No trusted IP available (rare on Netlify — x-nf-client-
  //      connection-ip is platform-set; possible on misconfigured
  //      self-hosted or direct dev): Apply a small, INDEPENDENT global
  //      cap on the shared fallback identifier. This bounds abuse
  //      without rejecting legitimate users outright and WITHOUT
  //      letting an attacker lock out real per-IP users by flooding a
  //      shared "unknown" per-IP bucket. See Phase B3.4.1 report for
  //      the trade-off analysis.
  //
  // In BOTH paths, the attempt is recorded (INSERT) before the count
  // check, so a rejected attempt still counts toward the next window.
  if (clientIp) {
    const decision = await checkAndRecordRegistrationRateLimit(db, clientIp);
    if (!decision.allowed) {
      throw Err.rateLimited(
        `Too many registration attempts from this IP. Try again in ${decision.retryAfterSeconds} seconds.`,
      );
    }
  } else {
    // Independent global fallback — bounds abuse when trusted IP
    // metadata is missing. The cap is smaller than the per-IP cap
    // (see REG_NO_TRUSTED_IP_MAX_ATTEMPTS in rateLimit.ts).
    const decision = await checkAndRecordRegistrationRateLimit(
      db,
      REGISTRATION_NO_TRUSTED_IP_BUCKET,
      // Default maxAttempts is the per-IP cap (5). The fallback uses
      // the smaller, independent global cap defined in rateLimit.ts.
      // We pass it explicitly to make the fallback cap visible at the
      // call site. The value is exported as a function for introspection;
      // here we read it via registrationRateLimitThresholds().
      registrationRateLimitThresholds().noTrustedIp.maxAttempts,
    );
    if (!decision.allowed) {
      throw Err.rateLimited(
        `Too many registration attempts. Please try again in ${decision.retryAfterSeconds} seconds.`,
      );
    }
  }

  const result = await db.withTxSerializable(async (tx) => {
    // Re-check idempotency inside the tx (concurrent duplicate).
    if (input.idempotencyKey) {
      const recheck = await tx.query<{ id: string; idempotency_body_hash: string | null }>(
        `SELECT id, idempotency_body_hash
           FROM registration_applications
          WHERE academy_id = $1 AND idempotency_key = $2
          LIMIT 1;`,
        [input.academyId, input.idempotencyKey],
      );
      const row = recheck.rows[0] as { id: string; idempotency_body_hash: string | null } | undefined;
      if (row) {
        if (row.idempotency_body_hash === bodyHash) {
          return { applicationId: row.id, replayed: true };
        }
        throw Err.conflict(
          "Idempotency key was already used with different request data.",
          "idempotency_key_reuse",
        );
      }
    }

    const id = newId();
    await tx.query(
      `INSERT INTO registration_applications
         (id, academy_id, parent_full_name, parent_phone, parent_email, preferred_contact,
          child_full_name, child_date_of_birth, class_preference, preferred_day, notes,
          source, idempotency_key, idempotency_body_hash, submitted_ip, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'website', $12, $13, $14, 'pending');`,
      [
        id, input.academyId,
        input.parentFullName,
        input.parentPhone,
        input.parentEmail ?? null,
        input.preferredContact ?? null,
        input.childFullName,
        input.childDateOfBirth ?? null,
        input.classPreference ?? null,
        input.preferredDay ?? null,
        input.notes ?? null,
        input.idempotencyKey ?? null,
        bodyHash,
        clientIp,
      ],
    );

    return { applicationId: id, replayed: false };
  });

  return result;
}

// === Admin: list + detail ===============================================

export async function listRegistrationApplications(
  principal: Principal,
  academyId: string,
  statusFilter: "pending" | "approved" | "rejected" | "all" = "pending",
  db: DbClient = getDb(),
): Promise<RegistrationApplicationRow[]> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  const params: unknown[] = [academyId];
  let statusClause = "";
  if (statusFilter !== "all") {
    params.push(statusFilter);
    statusClause = `AND status = $2`;
  }

  const result = await db.query<RegistrationApplicationRow>(
    `SELECT id, academy_id AS "academyId",
            parent_full_name AS "parentFullName", parent_phone AS "parentPhone",
            parent_email AS "parentEmail", preferred_contact AS "preferredContact",
            child_full_name AS "childFullName",
            child_date_of_birth AS "childDateOfBirth",
            class_preference AS "classPreference", preferred_day AS "preferredDay",
            notes, source, status, reviewed_by AS "reviewedBy",
            to_char(reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "reviewedAt",
            rejection_reason AS "rejectionReason", student_id AS "studentId",
            to_char(submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "submittedAt"
       FROM registration_applications
      WHERE academy_id = $1 ${statusClause}
      ORDER BY submitted_at DESC;`,
    params,
  );
  return result.rows as RegistrationApplicationRow[];
}

export async function getRegistrationApplication(
  principal: Principal,
  academyId: string,
  applicationId: string,
  db: DbClient = getDb(),
): Promise<RegistrationApplicationRow> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  const result = await db.query<RegistrationApplicationRow>(
    `SELECT id, academy_id AS "academyId",
            parent_full_name AS "parentFullName", parent_phone AS "parentPhone",
            parent_email AS "parentEmail", preferred_contact AS "preferredContact",
            child_full_name AS "childFullName",
            child_date_of_birth AS "childDateOfBirth",
            class_preference AS "classPreference", preferred_day AS "preferredDay",
            notes, source, status, reviewed_by AS "reviewedBy",
            to_char(reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "reviewedAt",
            rejection_reason AS "rejectionReason", student_id AS "studentId",
            to_char(submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "submittedAt"
       FROM registration_applications
      WHERE id = $1 AND academy_id = $2
      LIMIT 1;`,
    [applicationId, academyId],
  );
  const row = result.rows[0] as RegistrationApplicationRow | undefined;
  if (!row) throw Err.notFound("Registration application not found in this academy.");
  return row;
}

// === Admin: approve =====================================================

/**
 * Approve a registration application. Creates operational records:
 *   - student (via createStudent — reuses existing domain + constraints).
 *   - guardian user (if parent_email is unique) + guardian_student_link.
 *   - enrollment (if class_preference resolves to a real class UUID —
 *     otherwise skipped; the Admin can enroll manually later).
 *
 * Does NOT create packages, entitlements, or payments.
 *
 * Idempotent: if already approved, returns the existing student_id.
 *
 * Duplicate detection: if a student with the same full_name + DOB already
 * exists in the academy, the approval FAILS with CONFLICT. The Admin must
 * resolve manually (reject the application or archive the existing student).
 *
 * Transactional: SERIALIZABLE tx — all records created or none.
 */
export async function approveRegistration(
  principal: Principal,
  academyId: string,
  applicationId: string,
  db: DbClient = getDb(),
): Promise<{ studentId: string; replayed: boolean }> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  // Pre-compute the Argon2id hash for the provisional guardian user
  // OUTSIDE the SERIALIZABLE tx — Argon2id is CPU-intensive and should
  // not run inside a DB transaction. The hash is only used if the
  // parent_email doesn't match an existing user (determined inside the tx).
  const provisionalPassword = `provisional-${newId()}`;
  const provisionalHash = await hashPassword(provisionalPassword);
  const provisionalParams = JSON.stringify(paramsToJson());

  return db.withTxSerializable(async (tx) => {
    // Load + lock the application.
    const appResult = await tx.query<{
      id: string; status: string; student_id: string | null;
      parent_full_name: string; parent_email: string | null;
      child_full_name: string; child_date_of_birth: string | null;
      class_preference: string | null;
      resolved_guardian_user_id: string | null;
    }>(
      `SELECT id, status, student_id, parent_full_name, parent_email,
              child_full_name, child_date_of_birth, class_preference,
              resolved_guardian_user_id
         FROM registration_applications
        WHERE id = $1 AND academy_id = $2
        LIMIT 1;`,
      [applicationId, academyId],
    );
    const app = appResult.rows[0] as
      | { id: string; status: string; student_id: string | null; parent_full_name: string; parent_email: string | null; child_full_name: string; child_date_of_birth: string | null; class_preference: string | null; resolved_guardian_user_id: string | null }
      | undefined;
    if (!app) throw Err.notFound("Registration application not found in this academy.");
    await tx.query(`SELECT id FROM registration_applications WHERE id = $1 FOR UPDATE;`, [app.id]);

    // Idempotent: already approved → return existing student_id.
    if (app.status === "approved" && app.student_id) {
      return { studentId: app.student_id, replayed: true };
    }
    if (app.status === "rejected") {
      throw Err.conflict("Cannot approve a rejected application.");
    }

    // Duplicate student detection — safe policy:
    //   - Same full_name + same non-null DOB → definitive duplicate → CONFLICT.
    //   - Same full_name + either DOB is NULL → ambiguous (cannot rule out
    //     a match) → CONFLICT requiring Admin resolution.
    //   - Same full_name + both DOBs non-null and different → safe, proceed.
    // Never treats name-only match as definitive identity, but does flag
    // it as a credible possible match requiring resolution.
    const dupResult = await tx.query<{ id: string }>(
      `SELECT s.id
         FROM students s
        WHERE s.academy_id = $1
          AND s.full_name = $2
          AND (
            -- Both DOBs non-null and match → definitive duplicate.
            (s.date_of_birth IS NOT NULL AND $3::date IS NOT NULL AND s.date_of_birth = $3::date)
            -- Either DOB NULL → ambiguous (cannot rule out a match).
            OR s.date_of_birth IS NULL
            OR $3::date IS NULL
          )
        LIMIT 1;`,
      [academyId, app.child_full_name, app.child_date_of_birth],
    );
    if (dupResult.rows[0]) {
      throw Err.conflict(
        "A student with the same name already exists in the academy" +
        (app.child_date_of_birth
          ? " and the date of birth matches or is missing on the existing record."
          : " and this application has no date of birth."
        ) + " Resolve the duplicate before approving (archive the existing student or reject this application).",
      );
    }

    // Parent email required for reliable guardian provisioning.
    // Without email, the parent cannot be reliably identified or provisioned.
    // The Admin must add an email to the application before approving.
    if (!app.parent_email) {
      throw Err.conflict(
        "Cannot approve: parent email is required for guardian provisioning. Add the parent's email to the application, or approve without a guardian link via manual Admin action.",
      );
    }

    // Create the student (reuses the existing domain operation).
    // We need a Principal that works inside this tx — createStudent uses
    // its own tx internally, so we call it AFTER this tx with the result.
    // Actually, createStudent opens its own tx. To keep this atomic, we
    // inline the student creation here instead of calling createStudent.
    const studentId = newId();
    await tx.query(
      `INSERT INTO students (id, academy_id, full_name, date_of_birth, notes)
       VALUES ($1, $2, $3, $4, $5);`,
      [
        studentId, academyId, app.child_full_name,
        app.child_date_of_birth, `Approved from registration ${app.id}`,
      ],
    );
    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "student.create_from_registration",
      targetType: "students", targetId: studentId,
      after: { fullName: app.child_full_name, applicationId: app.id },
    });

    // Resolve class_preference to a class (academy-scoped).
    //
    // The public registration form accepts free-text classPreference, so
    // the value may be either:
    //   (a) a class UUID (rare — the public form doesn't expose UUIDs), or
    //   (b) a class NAME (e.g. "Semangat") — the common case.
    //
    // We try BOTH: if the value parses as a UUID, look up by id; otherwise
    // (or if the id lookup returns nothing), fall back to a case-insensitive
    // name match within the academy. If neither matches, enrollment is
    // skipped (the Admin can enroll manually later).
    //
    // CRITICAL: the original code queried `WHERE id = $1` on the uuid
    // column with an arbitrary string, which caused a 502 PostgreSQL type
    // error when class_preference was a class name like "Semangat". This
    // fix validates the UUID format first and falls back to name matching.
    if (app.class_preference) {
      let classId: string | null = null;

      // Validate UUID format before querying the uuid column. The regex
      // matches RFC 4122 UUIDs (8-4-4-4-12 hex digits). Non-matching
      // strings skip the id lookup and go straight to name matching.
      const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
      if (UUID_RE.test(app.class_preference)) {
        const idResult = await tx.query<{ id: string }>(
          `SELECT id FROM classes WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
          [app.class_preference, academyId],
        );
        if (idResult.rows[0]) {
          classId = (idResult.rows[0] as { id: string }).id;
        }
      }

      // Fall back to case-insensitive name match within the academy.
      // LOWER(class_name) = LOWER($1) is case-insensitive and collation-safe.
      if (!classId) {
        const nameResult = await tx.query<{ id: string }>(
          `SELECT id FROM classes
            WHERE academy_id = $1
              AND LOWER(name) = LOWER($2)
              AND is_active = true
            LIMIT 1;`,
          [academyId, app.class_preference],
        );
        if (nameResult.rows[0]) {
          classId = (nameResult.rows[0] as { id: string }).id;
        }
      }

      if (classId) {
        // Compute today's date in Jakarta for effective_from.
        const today = await computeTodayJakarta(tx);
        await tx.query(
          `INSERT INTO student_enrollments (id, student_id, class_id, effective_from)
           VALUES ($1, $2, $3, $4);`,
          [newId(), studentId, classId, today],
        );
        await writeAudit({
          tx, academyId, actorUserId: principal.userId,
          action: "enrollment.create_from_registration",
          targetType: "student_enrollments", targetId: studentId,
          after: { studentId, classId, effectiveFrom: today },
        });
      }
    }

    // Guardian provisioning — safe policy:
    //   - If resolved_guardian_user_id is set (Admin explicitly verified):
    //     link to that guardian (no new user, no email check).
    //   - If parent_email does NOT match an existing user → create a new
    //     provisional user (safe: the email is new).
    //   - If parent_email MATCHES an existing user → CONFLICT (Admin must
    //     resolve via resolveExistingGuardian first).
    let guardianUserId: string | null = null;
    if (app.resolved_guardian_user_id) {
      // Admin explicitly selected an existing guardian after verification.
      guardianUserId = app.resolved_guardian_user_id;
    } else if (app.parent_email) {
      const existingUser = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 LIMIT 1;`,
        [app.parent_email],
      );
      if (existingUser.rows[0]) {
        // An account with this email already exists. Do NOT auto-link.
        // The applicant might not be the account owner.
        throw Err.conflict(
          "An account with this parent email already exists. The Admin must verify the parent's identity and manually link the guardian to the student before approving, or instruct the parent to use a different email.",
        );
      } else {
        // Create a provisional parent user with must_change_password=true.
        // The hash was pre-computed outside the tx.
        guardianUserId = newId();
        await tx.query(
          `INSERT INTO users (id, email, status, must_change_password)
           VALUES ($1, $2, 'active', true);`,
          [guardianUserId, app.parent_email],
        );
        await tx.query(
          `INSERT INTO user_credentials (user_id, argon2id_hash, argon2_params)
           VALUES ($1, $2, $3);`,
          [guardianUserId, provisionalHash, provisionalParams],
        );
        await tx.query(
          `INSERT INTO academy_memberships (id, user_id, academy_id, role, status)
           VALUES ($1, $2, $3, 'parent', 'active');`,
          [newId(), guardianUserId, academyId],
        );
        await writeAudit({
          tx, academyId, actorUserId: principal.userId,
          action: "guardian.create_from_registration",
          targetType: "users", targetId: guardianUserId,
          after: { email: app.parent_email, studentId },
        });
      }

    }

    // Link guardian to student (UNIQUE on guardian_user_id + student_id).
    // This runs for BOTH resolved guardians and newly-provisioned users.
    if (guardianUserId) {
      try {
        await tx.query(
          `INSERT INTO guardian_student_links (id, guardian_user_id, student_id, is_primary, relationship)
           VALUES ($1, $2, $3, true, null);`,
          [newId(), guardianUserId, studentId],
        );
      } catch {
        // Already linked — not an error.
      }
    }

    // Mark the application as approved.
    await tx.query(
      `UPDATE registration_applications
          SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
              student_id = $3, updated_at = now()
        WHERE id = $1;`,
      [app.id, principal.userId, studentId],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "registration.approve",
      targetType: "registration_applications", targetId: app.id,
      after: { studentId, guardianUserId },
    });

    return { studentId, replayed: false };
  });
}

// === Admin: reject ======================================================

export async function rejectRegistration(
  principal: Principal,
  academyId: string,
  applicationId: string,
  reason: string,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!reason || reason.trim() === "") {
    throw Err.validation("A non-empty rejection reason is required.");
  }

  return db.withTxSerializable(async (tx) => {
    const appResult = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM registration_applications
        WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
      [applicationId, academyId],
    );
    const app = appResult.rows[0] as { id: string; status: string } | undefined;
    if (!app) throw Err.notFound("Registration application not found in this academy.");
    await tx.query(`SELECT id FROM registration_applications WHERE id = $1 FOR UPDATE;`, [app.id]);

    if (app.status === "approved") {
      throw Err.conflict("Cannot reject an already-approved application.");
    }
    if (app.status === "rejected") {
      throw Err.conflict("Application is already rejected.");
    }

    await tx.query(
      `UPDATE registration_applications
          SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
              rejection_reason = $3, updated_at = now()
        WHERE id = $1;`,
      [app.id, principal.userId, reason],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "registration.reject",
      targetType: "registration_applications", targetId: app.id,
      after: { reason },
    });
  });
}

// === Helpers =============================================================

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== "idempotencyKey").sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

// === Admin: resolve existing guardian (P2) ==============================

/**
 * Admin explicitly selects an existing guardian for a registration
 * application. This is used when the parent_email matches an existing
 * user and the Admin has verified the parent's identity out-of-band.
 *
 * Sets resolved_guardian_user_id on the application. When approval
 * runs, it links the child to this guardian instead of creating a new
 * user. The guardian must belong to the same academy (have an active
 * academy membership).
 *
 * Audited: records the Admin, timestamp, reason, and selected guardian.
 */
export async function resolveExistingGuardian(
  principal: Principal,
  academyId: string,
  applicationId: string,
  guardianUserId: string,
  reason: string,
  db: DbClient = getDb(),
): Promise<void> {
  requireAcademyContext(principal, academyId);
  requireRole(principal, "admin", academyId);

  if (!reason || reason.trim() === "") {
    throw Err.validation("A non-empty resolution reason is required.");
  }

  return db.withTxSerializable(async (tx) => {
    // Load + lock the application.
    const appResult = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM registration_applications
        WHERE id = $1 AND academy_id = $2 LIMIT 1;`,
      [applicationId, academyId],
    );
    const app = appResult.rows[0] as { id: string; status: string } | undefined;
    if (!app) throw Err.notFound("Registration application not found in this academy.");
    await tx.query(`SELECT id FROM registration_applications WHERE id = $1 FOR UPDATE;`, [app.id]);

    if (app.status === "approved") {
      throw Err.conflict("Cannot resolve guardian for an already-approved application.");
    }

    // Verify the guardian belongs to the same academy (active membership).
    const guardianResult = await tx.query<{ id: string }>(
      `SELECT u.id
         FROM users u
         JOIN academy_memberships am ON am.user_id = u.id
        WHERE u.id = $1
          AND am.academy_id = $2
          AND am.status = 'active'
        LIMIT 1;`,
      [guardianUserId, academyId],
    );
    if (!guardianResult.rows[0]) {
      throw Err.notFound("Selected guardian not found in this academy.");
    }

    // Set the resolution.
    await tx.query(
      `UPDATE registration_applications
          SET resolved_guardian_user_id = $2,
              resolution_reason = $3,
              resolved_by = $4,
              resolved_at = now(),
              updated_at = now()
        WHERE id = $1;`,
      [app.id, guardianUserId, reason, principal.userId],
    );

    await writeAudit({
      tx, academyId, actorUserId: principal.userId,
      action: "registration.resolve_guardian",
      targetType: "registration_applications", targetId: app.id,
      after: { guardianUserId },
      reason,
    });
  });
}

export function computeBodyHash(input: SubmitRegistrationInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * Compute today's date in Asia/Jakarta using a SQL query (so it works
 * inside a tx and doesn't depend on the server's clock).
 */
async function computeTodayJakarta(tx: TxClient): Promise<string> {
  const result = await tx.query<{ today: string }>(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS today;`,
  );
  return (result.rows[0] as { today: string }).today;
}
