/**
 * Phase B5.6c — Language consistency tests for PublicLandingPage.
 *
 * Verifies that the public landing page's application-code strings
 * (UI labels, section headings, error/loading messages, fallback text)
 * are in Bahasa Indonesia. Database-seeded content (hero title,
 * programs, coaches, etc.) is admin-editable and NOT tested here —
 * it comes from the DB via the API.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "../../src/components/public/PublicLandingPage.tsx"),
  "utf-8",
);

test("PublicLandingPage: key Indonesian UI strings present", () => {
  expect(SRC).toContain("Memuat halaman akademi");
  expect(SRC).toContain("Halaman akademi segera hadir");
  expect(SRC).toContain("Akademi ini belum menerbitkan");
  expect(SRC).toContain("Masuk Admin");
  expect(SRC).toContain("Gagal memuat halaman");
  expect(SRC).toContain("Kesalahan tidak diketahui");
  expect(SRC).toContain("Kesalahan jaringan");
  expect(SRC).toContain("Gagal memuat halaman landing");
  expect(SRC).toContain("Latihan. Bertanding. Berkembang.");
  expect(SRC).toContain("Daftar Sekarang");
  expect(SRC).toContain("Cek Status");
  expect(SRC).toContain("> Masuk\n");  // button text after icon
  expect(SRC).toContain(">Program</"); // section heading in <h2>
  expect(SRC).toContain("Jadwal Latihan");
  expect(SRC).toContain(">Hari</th");
  expect(SRC).toContain(">Jam</th");
  expect(SRC).toContain(">Kelas</th");
  expect(SRC).toContain("Pelatih Kami");
  expect(SRC).toContain(">Galeri</");
  expect(SRC).toContain("Unggulan");
  expect(SRC).toContain(">Video</");
  expect(SRC).toContain(">Lokasi</");
  expect(SRC).toContain("Lihat di peta");
  expect(SRC).toContain(">Kontak</");
  expect(SRC).toContain("Siap Bergabung?");
  expect(SRC).toContain("Daftarkan anak Anda hari ini");
  expect(SRC).toContain("Hak cipta dilindungi");
  expect(SRC).toContain("Diterbitkan");
  expect(SRC).toContain("Versi");
});

test("PublicLandingPage: no English UI strings remain", () => {
  expect(SRC).not.toContain("Loading academy page");
  expect(SRC).not.toContain("Academy page coming soon");
  expect(SRC).not.toContain("Admin Login");
  expect(SRC).not.toContain("Failed to load page");
  expect(SRC).not.toContain("Failed to load landing");
  expect(SRC).not.toContain("Network error");
  expect(SRC).not.toContain("Train. Compete. Excel.");
  expect(SRC).not.toContain("Register Now");
  expect(SRC).not.toContain("Check Status");
  expect(SRC).not.toContain(">Login<");
  expect(SRC).not.toContain(">Programs<");
  expect(SRC).not.toContain(">Schedule<");
  expect(SRC).not.toContain(">Day<");
  expect(SRC).not.toContain(">Time<");
  expect(SRC).not.toContain(">Class<");
  expect(SRC).not.toContain("Our Coaches");
  expect(SRC).not.toContain(">Gallery<");
  expect(SRC).not.toContain(">Featured<");
  expect(SRC).not.toContain(">Videos<");
  expect(SRC).not.toContain(">Location<");
  expect(SRC).not.toContain("View on map");
  expect(SRC).not.toContain(">Contact<");
  expect(SRC).not.toContain("Ready to Join?");
  expect(SRC).not.toContain("Register your child today");
  expect(SRC).not.toContain("All rights reserved");
  expect(SRC).not.toContain("Published ");
  expect(SRC).not.toContain("Version ");
});

test("PublicLandingPage: DB content fields remain as variable references (not translated)", () => {
  // The DB-seeded content (hero, about, programs, schedules, coaches,
  // location, contact) is rendered from the API response — the component
  // must NOT hardcode translated content for these fields.
  expect(SRC).toContain("c.hero?.title");
  expect(SRC).toContain("c.hero?.subtitle");
  expect(SRC).toContain("c.about?.title");
  expect(SRC).toContain("c.about?.body");
  expect(SRC).toContain("c.programs");
  expect(SRC).toContain("c.schedules");
  expect(SRC).toContain("c.coaches");
  expect(SRC).toContain("c.location?.address");
  expect(SRC).toContain("c.contact?.phone");
  expect(SRC).toContain("c.registrationCta?.text");
  expect(SRC).toContain("page.gallery");
  expect(SRC).toContain("page.videos");
  expect(SRC).toContain("page.academyName");
});

test("PublicLandingPage: published-content-only rendering preserved", () => {
  // The component fetches from /api/public/landing which returns ONLY
  // published content. This contract is unchanged.
  expect(SRC).toContain("/api/public/landing");
  expect(SRC).toContain("page.publishedAt");
  expect(SRC).toContain("page.versionNumber");
});

test("PublicLandingPage: date locale changed to Indonesian", () => {
  // The footer date format was changed from "en-CA" (ISO) to "id-ID"
  // (Indonesian DD/MM/YYYY format).
  expect(SRC).toContain('"id-ID"');
  expect(SRC).not.toContain('"en-CA"');
});
