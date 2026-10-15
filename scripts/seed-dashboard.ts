import { loadEnv } from "@/lib/env";
loadEnv();
import { getDb } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { hashPassword, paramsToJson } from "@/lib/auth/password";

const db = getDb();
const ACADEMY_ID = "00000000-0000-0000-0000-000000000001";
const adminId = (await db.query<{id:string}>(`SELECT id FROM users WHERE email='admin@example.com'`)).rows[0]!.id;

// Compute today in Jakarta
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year:"numeric", month:"2-digit", day:"2-digit" });
const parts = fmt.formatToParts(new Date());
const y = parts.find(p=>p.type==="year")!.value;
const m = parts.find(p=>p.type==="month")!.value;
const d = parts.find(p=>p.type==="day")!.value;
const today = `${y}-${m}-${d}`;
const monthStart = `${y}-${m}-01`;

// Class + schedule
const classId = randomUUID();
await db.query(`INSERT INTO classes (id, academy_id, name, capacity) VALUES ($1,$2,'Dashboard Class',12);`,[classId,ACADEMY_ID]);
const svId = randomUUID();
await db.query(`INSERT INTO schedule_versions (id, class_id, effective_from, status) VALUES ($1,$2,'2026-01-01','active');`,[svId,classId]);
const slotId = randomUUID();
await db.query(`INSERT INTO schedule_slots (id, schedule_version_id, weekday, start_time, end_time) VALUES ($1,$2,2,'15:00','16:00');`,[slotId,svId]);

// 2 students enrolled
const s1 = randomUUID(), s2 = randomUUID();
await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1,$2,'Andi Wijaya');`,[s1,ACADEMY_ID]);
await db.query(`INSERT INTO students (id, academy_id, full_name) VALUES ($1,$2,'Budi Santoso');`,[s2,ACADEMY_ID]);
await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1,$2,$3,'2026-01-01');`,[randomUUID(),s1,classId]);
await db.query(`INSERT INTO student_enrollments (id, student_id, class_id, effective_from) VALUES ($1,$2,$3,$4);`,[randomUUID(),s2,classId,today]); // starts today

// Today's occurrence + attendance
const occId = randomUUID();
await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1,$2,$3,$4,$5,$6,'${today} 15:00:00','${today} 16:00:00','planned',12);`,[occId,ACADEMY_ID,classId,slotId,svId,today]);
await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1,$2,$3,'present',$4);`,[randomUUID(),occId,s1,adminId]);
await db.query(`INSERT INTO attendance_records (id, training_occurrence_id, student_id, status, recorded_by) VALUES ($1,$2,$3,'late',$4);`,[randomUUID(),occId,s2,adminId]);

// Package plan + package with 4 entitlements (2 active, 1 completed, 1 skipped)
const planId = randomUUID();
await db.query(`INSERT INTO package_plans (id, academy_id, name, session_count) VALUES ($1,$2,'Starter 4',4);`,[planId,ACADEMY_ID]);
const pkgId = randomUUID();
await db.query(`INSERT INTO student_packages (id, student_id, package_plan_id, class_id_at_purchase) VALUES ($1,$2,$3,$4);`,[pkgId,s1,planId,classId]);
const compOcc = randomUUID();
await db.query(`INSERT INTO training_occurrences (id, academy_id, class_id, schedule_slot_id, schedule_version_id, occurrence_date, start_at, end_at, status, capacity) VALUES ($1,$2,$3,$4,$5,'2027-01-05','2027-01-05 15:00:00','2027-01-05 16:00:00','planned',12);`,[compOcc,ACADEMY_ID,classId,slotId,svId]);
await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, original_occurrence_id, assigned_occurrence_id) VALUES ($1,$2,1,'completed',$3,$3);`,[randomUUID(),pkgId,compOcc]);
await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status, skip_used) VALUES ($1,$2,2,'skipped',TRUE);`,[randomUUID(),pkgId]);
await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1,$2,3,'active');`,[randomUUID(),pkgId]); // unassigned
await db.query(`INSERT INTO session_entitlements (id, student_package_id, sequence, status) VALUES ($1,$2,4,'active');`,[randomUUID(),pkgId]); // unassigned

// This month's payment + expense
await db.query(`INSERT INTO payments (id, academy_id, payer_user_id, student_id, submitted_amount, currency, status, reviewed_by, reviewed_at, payer_name, payment_method, payment_date, recorded_by, idempotency_key, idempotency_body_hash, notes) VALUES ($1,$2,$3,$4,400000,'IDR','confirmed',$3,now(),'Andi Sr','cash',$5,$3,$6,$7,'First payment');`,[randomUUID(),ACADEMY_ID,adminId,s1,monthStart,`k-${randomUUID()}`,"h1"]);
await db.query(`INSERT INTO academy_expenses (id, academy_id, category, amount, currency, incurred_on, created_by) VALUES ($1,$2,'field_rent',1500000,'IDR',$3,$4);`,[randomUUID(),ACADEMY_ID,monthStart,adminId]);

console.log("Dashboard seed data inserted for", today);
process.exit(0);
