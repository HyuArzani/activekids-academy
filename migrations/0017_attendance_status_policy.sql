-- 0017_attendance_status_policy.sql
-- Preserve historical 'late' information while canonicalizing the status domain.
ALTER TABLE attendance_records ADD COLUMN legacy_status text;
UPDATE attendance_records SET legacy_status = status, status = 'present' WHERE status = 'late';
ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check
  CHECK (status IN ('present', 'absent', 'excused'));
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_legacy_status_check
  CHECK (legacy_status IS NULL OR legacy_status = 'late');
