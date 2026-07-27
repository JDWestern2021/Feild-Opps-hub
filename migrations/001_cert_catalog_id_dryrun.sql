-- DRY RUN: cert_catalog_id mapping report
-- Run this in Supabase SQL editor and send Jeremy the output before applying.
-- This query writes NOTHING. It only shows what would happen.

WITH matches AS (
  SELECT
    wc.cert_name,
    COUNT(DISTINCT wc.id)           AS record_count,
    COUNT(DISTINCT c.id)            AS catalog_matches,
    MIN(c.id)                       AS matched_catalog_id,
    MIN(c.display_name)             AS matched_display_name,
    MIN(c.tier)                     AS matched_tier,
    CASE
      WHEN COUNT(DISTINCT c.id) = 1 THEN 'AUTO_MATCH'
      WHEN COUNT(DISTINCT c.id) = 0 THEN 'NO_MATCH — manual resolution required'
      ELSE 'AMBIGUOUS — manual resolution required'
    END AS action
  FROM worker_certifications wc
  LEFT JOIN cert_catalog c
         ON LOWER(TRIM(c.display_name)) = LOWER(TRIM(wc.cert_name))
        AND wc.catalog_id IS NULL
  WHERE wc.catalog_id IS NULL
  GROUP BY wc.cert_name
)
SELECT
  cert_name,
  record_count,
  matched_display_name,
  matched_tier,
  action
FROM matches
ORDER BY action, cert_name;
