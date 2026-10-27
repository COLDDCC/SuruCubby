-- 分拣：仓库把一个日本快递箱里的东西铺在地上，照着卡片上的 cn 分堆，点「发送」一次落定：
-- 签收、拼团分进回国箱（可多箱，当场填回国单号）、直邮按人建包裹（填 EMS 单号和整包重量）。

ALTER TABLE items ADD COLUMN cn_label TEXT;          -- 导入表里 cn 的原文（卡片上白底黑字写的就是它）
ALTER TABLE items ADD COLUMN jp_tracking_no TEXT;    -- 这一件在哪个日本快递箱里（表里有就导入，没有就分拣时记上）
ALTER TABLE items ADD COLUMN ordered_at TEXT;        -- 表里写了下单时间就记在件上，没有用批次的
ALTER TABLE items ADD COLUMN sort_found_at TEXT;     -- 分拣时点了「找到了」（存在服务器上，换手机、两个人一起分都对得上）
ALTER TABLE items ADD COLUMN sort_found_by TEXT;
ALTER TABLE items ADD COLUMN sorted_at TEXT;         -- 「发送」落定的时间
ALTER TABLE items ADD COLUMN sort_session_id INTEGER;
CREATE INDEX idx_items_jp_tracking ON items(batch_id, jp_tracking_no);

-- 状态日志记上是谁做的（日本仓签收、分拣、寄出）
ALTER TABLE status_logs ADD COLUMN by_name TEXT;

CREATE TABLE sort_sessions (
  id              INTEGER PRIMARY KEY,
  batch_id        INTEGER NOT NULL REFERENCES batches(id),
  jp_tracking_no  TEXT,
  box_count       INTEGER NOT NULL DEFAULT 0,
  parcel_count    INTEGER NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,
  missing_count   INTEGER NOT NULL DEFAULT 0,
  summary         TEXT,                               -- 发群用的结果文字
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_sort_sessions_batch ON sort_sessions(batch_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('max_boxes_per_sort', '9');
