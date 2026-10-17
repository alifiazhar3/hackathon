/*
# Create drippy_scans table (single-tenant, no auth)

1. New Tables
- `drippy_scans`
  - `id` (uuid, primary key)
  - `created_at` (timestamptz, defaults to now)
  - `severity` (text, not null) — one of 'low', 'medium', 'high'
  - `dominant_freq` (integer, not null) — dominant frequency in Hz detected by the mic
  - `high_energy` (numeric, not null) — normalized 0–1 high-band energy reading
  - `total_energy` (numeric, not null) — normalized 0–1 overall energy reading
  - `score` (numeric, not null) — computed leak score 0–1

2. Security
- Enable RLS on `drippy_scans`.
- Single-tenant app with no sign-in: allow anon + authenticated full CRUD
  because the scan data is intentionally shared/public across all visitors.

3. Notes
- No user_id column since there is no auth in this hackathon app.
- Index on created_at desc for efficient history ordering.
*/

CREATE TABLE IF NOT EXISTS drippy_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  dominant_freq integer NOT NULL,
  high_energy numeric NOT NULL,
  total_energy numeric NOT NULL,
  score numeric NOT NULL
);

ALTER TABLE drippy_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_scans" ON drippy_scans;
CREATE POLICY "anon_select_scans" ON drippy_scans FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_scans" ON drippy_scans;
CREATE POLICY "anon_insert_scans" ON drippy_scans FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_scans" ON drippy_scans;
CREATE POLICY "anon_update_scans" ON drippy_scans FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_scans" ON drippy_scans;
CREATE POLICY "anon_delete_scans" ON drippy_scans FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS drippy_scans_created_at_idx ON drippy_scans (created_at DESC);
