-- 骏河屋拼团「个人仓库」· 初始结构
-- 约定：金额一律存整数「分」；日元存整数「円」；时间存 UTC ISO 字符串。

-- 客户
CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  qq            TEXT NOT NULL UNIQUE,
  nickname      TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  note          TEXT,
  created_at    TEXT NOT NULL
);

-- 名字别名：Excel 里 cn 列出现过的所有名字都映射到客户
CREATE TABLE customer_aliases (
  alias         TEXT PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id)
);
CREATE INDEX idx_aliases_customer ON customer_aliases(customer_id);

-- 批次（一张 Excel = 一个批次）
CREATE TABLE batches (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  ordered_at    TEXT,
  source_file   TEXT,
  file_hash     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_batches_hash ON batches(file_hash);

-- 包裹（日本 → 国内的一个箱子）
CREATE TABLE packages (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  tracking_no     TEXT,
  status          TEXT NOT NULL,
  total_fee_fen   INTEGER,
  total_weight_g  INTEGER,
  allocated_at    TEXT,
  created_at      TEXT NOT NULL
);

-- 包裹与批次多对多（默认一批一包，但允许例外）
CREATE TABLE package_batches (
  package_id    INTEGER NOT NULL REFERENCES packages(id),
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  PRIMARY KEY (package_id, batch_id)
);

-- 称重组：某包裹里某客户的一摞东西
CREATE TABLE weigh_groups (
  id              INTEGER PRIMARY KEY,
  package_id      INTEGER NOT NULL REFERENCES packages(id),
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  weight_g        INTEGER,
  intl_fee_fen    INTEGER,
  fee_paid        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (package_id, customer_id)
);

-- 国内寄出（需求方 → 客户）
CREATE TABLE shipments (
  id              INTEGER PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  tracking_no     TEXT,
  fee_fen         INTEGER NOT NULL DEFAULT 1000,
  fee_paid        INTEGER NOT NULL DEFAULT 0,
  shipped_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_shipments_customer ON shipments(customer_id);

-- 物品（核心表，一行 = 一件）
CREATE TABLE items (
  id                 INTEGER PRIMARY KEY,
  batch_id           INTEGER NOT NULL REFERENCES batches(id),
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  package_id         INTEGER REFERENCES packages(id),
  weigh_group_id     INTEGER REFERENCES weigh_groups(id),
  shipment_id        INTEGER REFERENCES shipments(id),
  row_no             INTEGER,
  title              TEXT NOT NULL,
  image_url          TEXT,
  product_url        TEXT,
  list_price_jpy     INTEGER,
  actual_price_jpy   INTEGER,
  goods_fee_fen      INTEGER NOT NULL,
  status             TEXT NOT NULL,
  goods_paid         INTEGER NOT NULL DEFAULT 0,
  -- 称重时找不到的物品标记为缺件，不参与国际运费分摊
  missing            INTEGER NOT NULL DEFAULT 0,
  exception_note     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_items_customer ON items(customer_id);
CREATE INDEX idx_items_batch ON items(batch_id);
CREATE INDEX idx_items_package ON items(package_id);
CREATE INDEX idx_items_weigh_group ON items(weigh_group_id);
CREATE INDEX idx_items_shipment ON items(shipment_id);
CREATE INDEX idx_items_status ON items(status);

-- 收款记录
CREATE TABLE payments (
  id              INTEGER PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  kind            TEXT NOT NULL,           -- goods / intl / domestic
  amount_fen      INTEGER NOT NULL,
  ref_type        TEXT,                    -- batch / weigh_group / shipment
  ref_id          INTEGER,
  note            TEXT,
  paid_at         TEXT NOT NULL
);
CREATE INDEX idx_payments_customer ON payments(customer_id);

-- 货款收款覆盖到哪些物品（便于撤销）
CREATE TABLE payment_items (
  payment_id      INTEGER NOT NULL REFERENCES payments(id),
  item_id         INTEGER NOT NULL REFERENCES items(id),
  PRIMARY KEY (payment_id, item_id)
);
CREATE INDEX idx_payment_items_item ON payment_items(item_id);

-- 状态日志，客户页的时间线从这里读
CREATE TABLE status_logs (
  id              INTEGER PRIMARY KEY,
  item_id         INTEGER NOT NULL REFERENCES items(id),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  at              TEXT NOT NULL
);
CREATE INDEX idx_status_logs_item ON status_logs(item_id, at);
CREATE INDEX idx_status_logs_to ON status_logs(to_status);

-- 分摊尾差记录（需求方承担的差额，便于对账）
CREATE TABLE rounding_logs (
  package_id      INTEGER PRIMARY KEY REFERENCES packages(id),
  diff_fen        INTEGER NOT NULL
);

-- 全局配置
CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('domestic_fee_fen', '1000');

-- 客户页 QQ 校验限流
CREATE TABLE token_attempts (
  token           TEXT PRIMARY KEY,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  window_start    TEXT NOT NULL,
  locked_until    TEXT
);
