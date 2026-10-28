-- 日本仓日常的几处细节：
--   一单分几个日本快递到：每个快递单号单独登记、单独签收，看得出哪个还没到；
--   回国箱记日本仓称的整箱重量和箱数（一个回国单号可能是几箱一起走）；
--   直邮待付款可以催：记谁、什么时候催过几次。

CREATE TABLE jp_shipments (
  id           INTEGER PRIMARY KEY,
  batch_id     INTEGER NOT NULL REFERENCES batches(id),
  tracking_no  TEXT NOT NULL,                 -- 统一去掉空格和横线后的写法
  arrived_at   TEXT,                          -- 日本仓点了「这个快递到了」或者分拣过这一箱
  arrived_by   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (batch_id, tracking_no)
);
CREATE INDEX idx_jp_shipments_batch ON jp_shipments(batch_id);

-- 已有数据：导入表里写过的运单号都登记上；分拣过的算已到
INSERT OR IGNORE INTO jp_shipments (batch_id, tracking_no, created_at)
  SELECT DISTINCT batch_id, jp_tracking_no, MIN(created_at) FROM items
   WHERE jp_tracking_no IS NOT NULL AND TRIM(jp_tracking_no) != ''
   GROUP BY batch_id, jp_tracking_no;
INSERT OR IGNORE INTO jp_shipments (batch_id, tracking_no, created_at)
  SELECT DISTINCT batch_id, jp_tracking_no, MIN(created_at) FROM sort_sessions
   WHERE jp_tracking_no IS NOT NULL GROUP BY batch_id, jp_tracking_no;
UPDATE jp_shipments
   SET arrived_at = (SELECT MIN(s.created_at) FROM sort_sessions s
                      WHERE s.batch_id = jp_shipments.batch_id AND s.jp_tracking_no = jp_shipments.tracking_no),
       arrived_by = (SELECT s.created_by FROM sort_sessions s
                      WHERE s.batch_id = jp_shipments.batch_id AND s.jp_tracking_no = jp_shipments.tracking_no
                      ORDER BY s.created_at LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM sort_sessions s
                WHERE s.batch_id = jp_shipments.batch_id AND s.jp_tracking_no = jp_shipments.tracking_no);

ALTER TABLE packages ADD COLUMN jp_weight_g INTEGER;      -- 日本仓封箱时称的整箱毛重（克）
ALTER TABLE packages ADD COLUMN carton_count INTEGER;     -- 这个回国单号下实际几箱

ALTER TABLE direct_parcels ADD COLUMN nudged_at TEXT;
ALTER TABLE direct_parcels ADD COLUMN nudged_by TEXT;
ALTER TABLE direct_parcels ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0;
