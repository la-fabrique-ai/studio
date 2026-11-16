-- Read-only preflight for labels_backlog_name_idx. Run before db:migrate.
-- Any returned row must be resolved manually before applying the migration.
-- Global labels (NULL backlog_id) are outside the local uniqueness rule.
SELECT backlog_id, lower(name) AS name_key, count(*) AS duplicate_count,
       array_agg(id ORDER BY id) AS label_ids,
       array_agg(name ORDER BY id) AS label_names
FROM labels
WHERE backlog_id IS NOT NULL
GROUP BY backlog_id, lower(name)
HAVING count(*) > 1
ORDER BY backlog_id, name_key;
