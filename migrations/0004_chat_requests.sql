CREATE TABLE chat_requests (
  chat_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'ignored', 'removed')),
  notified_at INTEGER
);
