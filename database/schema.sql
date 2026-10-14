-- MVP Ledger fresh PostgreSQL schema. Application creates this table automatically on startup.
CREATE TABLE IF NOT EXISTS app_documents (
  collection_name text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_name, id)
);
CREATE INDEX IF NOT EXISTS app_documents_collection_idx ON app_documents (collection_name);
CREATE INDEX IF NOT EXISTS app_documents_userid_idx ON app_documents (collection_name, (data->>'userId'));
CREATE INDEX IF NOT EXISTS app_documents_createdat_idx ON app_documents (collection_name, (data->>'createdAt'));
