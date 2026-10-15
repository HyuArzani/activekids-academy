/**
 * Phase B5.6d-2 — Language consistency tests for StudentList.
 *
 * Verifies that StudentList.tsx (including StudentListNoAccess) uses
 * Bahasa Indonesia for all user-facing strings. SOURCE-LEVEL checks.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/students/StudentList.tsx"),
  "utf-8",
);

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\s*\/\s*\}/g, "")
    .replace(/^.*\/\/.*$/gm, "");
}

const SRC_NC = stripComments(SRC);

test("StudentList: key Indonesian strings present", () => {
  expect(SRC).toContain("Memuat data siswa");
  expect(SRC).toContain("Gagal memuat data siswa");
  expect(SRC).toContain("Kesalahan jaringan");
  expect(SRC).toContain("Coba lagi");
  expect(SRC).toContain("Akademi");
  expect(SRC).toContain("Pilih akademi");
  expect(SRC).toContain("Belum ada siswa");
  expect(SRC).toContain("Siswa");
  expect(SRC).toContain("Nama");
  expect(SRC).toContain("Tanggal lahir");
  expect(SRC).toContain("Jenis kelamin");
  expect(SRC).toContain("Catatan");
  expect(SRC).toContain("siswa"); // badge: "{count} siswa"
});

test("StudentList: no English UI strings remain as display text", () => {
  expect(SRC_NC).not.toContain("Loading students");
  expect(SRC_NC).not.toContain("Failed to load students");
  expect(SRC_NC).not.toContain("Network error");
  expect(SRC_NC).not.toContain(">Retry<");
  expect(SRC_NC).not.toContain(">Academy<");
  expect(SRC_NC).not.toContain("Select academy");
  expect(SRC_NC).not.toContain("No students");
  expect(SRC_NC).not.toContain(">Students<");
  expect(SRC_NC).not.toContain(">Name</");
  expect(SRC_NC).not.toContain("Date of birth");
  expect(SRC_NC).not.toContain(">Gender<");
  expect(SRC_NC).not.toContain(">Notes<");
  expect(SRC_NC).not.toContain("student{"); // old pluralization pattern
});

test("StudentList: StudentListNoAccess is Indonesian", () => {
  expect(SRC).toContain("Akses Admin diperlukan");
  expect(SRC).toContain("Daftar siswa hanya tersedia untuk peran Admin");
  expect(SRC).toContain("tidak memiliki akses Admin");
  expect(SRC_NC).not.toContain("Admin access required");
  expect(SRC_NC).not.toContain("The student list is available");
});

test("StudentList: API field names remain English", () => {
  expect(SRC).toContain("academy_id");
  expect(SRC).toContain("full_name");
  expect(SRC).toContain("date_of_birth");
  expect(SRC).toContain("gender");
  expect(SRC).toContain("notes");
  expect(SRC).toContain("archived_at");
  expect(SRC).toContain("academyId");
  expect(SRC).toContain("selectedAcademyId");
});

test("StudentList: gender enum VALUES preserved, display translated", () => {
  expect(SRC).toContain('"male"');
  expect(SRC).toContain('"female"');
  expect(SRC).toContain("Laki-laki");
  expect(SRC).toContain("Perempuan");
});

test("StudentList: date formatting uses Indonesian locale", () => {
  expect(SRC).toContain('"id-ID"');
  expect(SRC).not.toContain('"en-CA"');
  expect(SRC).not.toContain('"en-US"');
});
