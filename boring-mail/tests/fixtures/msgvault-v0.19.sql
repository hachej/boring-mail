CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,
  identifier TEXT NOT NULL
);
CREATE TABLE participants (
  id INTEGER PRIMARY KEY,
  email_address TEXT,
  display_name TEXT,
  domain TEXT
);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_conversation_id TEXT,
  conversation_type TEXT NOT NULL,
  title TEXT,
  participant_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  last_message_at DATETIME,
  last_message_preview TEXT,
  UNIQUE(source_id, source_conversation_id)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_message_id TEXT,
  rfc822_message_id TEXT,
  message_type TEXT NOT NULL DEFAULT 'email',
  sent_at DATETIME,
  received_at DATETIME,
  internal_date DATETIME,
  sender_id INTEGER REFERENCES participants(id),
  subject TEXT,
  snippet TEXT,
  is_read BOOLEAN DEFAULT TRUE,
  attachment_count INTEGER DEFAULT 0,
  deleted_at DATETIME,
  deleted_from_source_at DATETIME
);
CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);
CREATE INDEX idx_messages_source ON messages(source_id);
CREATE INDEX idx_messages_live_sent_at
  ON messages(COALESCE(sent_at, received_at, internal_date) DESC, id DESC)
  WHERE deleted_at IS NULL AND deleted_from_source_at IS NULL;
CREATE TABLE message_recipients (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  participant_id INTEGER,
  recipient_type TEXT NOT NULL,
  display_name TEXT,
  email_address TEXT
);
CREATE INDEX idx_message_recipients_message ON message_recipients(message_id);
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  source_label_id TEXT,
  name TEXT NOT NULL,
  label_type TEXT,
  system_role TEXT
);
CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (message_id, label_id)
);
CREATE TABLE message_raw (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  raw_data BLOB NOT NULL,
  raw_format TEXT NOT NULL,
  compression TEXT DEFAULT 'zlib',
  encryption_version INTEGER DEFAULT 0
);
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_hash TEXT,
  storage_path TEXT NOT NULL
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED, subject, body, from_addr
);
