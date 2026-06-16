CREATE TABLE IF NOT EXISTS tokens (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL UNIQUE,
  token      TEXT UNIQUE,                -- NULL until user activates
  role       TEXT NOT NULL CHECK(role IN ('admin', 'power')),
  name       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uid            TEXT    NOT NULL,
  lat            REAL    NOT NULL,
  lng            REAL    NOT NULL,
  image_key      TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',
  name           TEXT    NOT NULL DEFAULT '',
  uploader_role  TEXT    NOT NULL DEFAULT 'user',
  taken_at       TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_status_loc ON photos (status, lat, lng);
CREATE INDEX IF NOT EXISTS idx_photos_uid        ON photos (uid);
CREATE INDEX IF NOT EXISTS idx_photos_created    ON photos (uid, created_at);
