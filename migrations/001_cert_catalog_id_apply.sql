-- APPLY: set catalog_id on worker_certifications for exact single-match cert names
-- Run ONLY after reviewing 001_cert_catalog_id_dryrun.sql output and confirming all
-- AUTO_MATCH rows are correct. Rows with NO_MATCH or AMBIGUOUS are untouched.

UPDATE worker_certifications wc
SET catalog_id = c.id
FROM cert_catalog c
WHERE LOWER(TRIM(c.display_name)) = LOWER(TRIM(wc.cert_name))
  AND wc.catalog_id IS NULL
  AND (
    -- Only update when exactly one catalog row matches this cert_name
    SELECT COUNT(*) FROM cert_catalog cx
    WHERE LOWER(TRIM(cx.display_name)) = LOWER(TRIM(wc.cert_name))
  ) = 1;

-- Verify: rows still without a catalog_id after the update need manual assignment
SELECT id, user_id, cert_name, 'NEEDS MANUAL CATALOG ASSIGNMENT' AS status
FROM worker_certifications
WHERE catalog_id IS NULL
ORDER BY cert_name, user_id;
