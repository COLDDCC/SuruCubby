-- 员工账号：管理员可以有多人（将来的国内分发者也开管理员），另有只管日本仓的账号。
-- 环境变量 ADMIN_PASSWORD 仍可用账号 admin 登录，作为引导和兜底，不在这张表里。
CREATE TABLE staff_users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'jp')),
  password_hash  TEXT NOT NULL,
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

-- 谁在什么时候做了什么：后台所有成功的写操作各记一行（密码字段不落库）。
CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY,
  staff_id     INTEGER,               -- 0 = 用 ADMIN_PASSWORD 登录的引导管理员
  staff_name   TEXT NOT NULL,
  role         TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INTEGER NOT NULL,
  detail       TEXT,
  at           TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_at ON audit_logs(at);
CREATE INDEX idx_audit_logs_staff ON audit_logs(staff_id, at);
