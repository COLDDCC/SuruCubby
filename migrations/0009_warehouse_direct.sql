-- 三方各看各的：群主放行、仓库分拣、直邮包裹单号放行。

-- 群主点了客户名字，这件东西才出现在客户自己的仓库里（先下单后收钱，防逃单）。
-- 老数据一律视为早就放行过，升级后客户页不会突然少东西。
ALTER TABLE items ADD COLUMN released_at TEXT;
UPDATE items SET released_at = created_at;

-- 仓库点【整理完成】的时间
ALTER TABLE items ADD COLUMN sorted_at TEXT;

-- 拼邮 / 直邮：拼邮跟群主一个箱子回国，直邮由仓库直接发给客户
ALTER TABLE customers ADD COLUMN ship_mode TEXT NOT NULL DEFAULT 'group';
ALTER TABLE customers ADD COLUMN direct_address TEXT;

-- 回国箱：kind='group' 是仓库装的拼邮箱；returned_at 是回国日期（发出那天）
ALTER TABLE packages ADD COLUMN kind TEXT NOT NULL DEFAULT 'order';
ALTER TABLE packages ADD COLUMN returned_at TEXT;

CREATE TABLE warehouse_users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE warehouse_attempts (
  username      TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL,
  locked_until  INTEGER NOT NULL
);

-- 直邮包裹：仓库提交单号 + 毛重 + 平铺图；群主收完钱点【单号放行】客户才看得到。
-- 两个单价各存一份：cost 是仓库收群主的，sale 是群主收客户的。
-- 仓库的接口只给 cost 以外的东西（连 cost 也不给），客户的接口只给 sale 算出来的运费。
CREATE TABLE parcels (
  id               INTEGER PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  tracking_no      TEXT NOT NULL,
  gross_weight_g   INTEGER NOT NULL,
  cost_fen_per_kg  INTEGER NOT NULL,
  sale_fen_per_kg  INTEGER NOT NULL,
  address_snapshot TEXT,
  note             TEXT,
  created_by       INTEGER REFERENCES warehouse_users(id),
  created_at       TEXT NOT NULL,
  submit_day       TEXT NOT NULL,
  released_at      TEXT
);
CREATE INDEX idx_parcels_customer ON parcels(customer_id);
CREATE INDEX idx_parcels_day ON parcels(submit_day);

ALTER TABLE items ADD COLUMN parcel_id INTEGER REFERENCES parcels(id);
CREATE INDEX idx_items_parcel ON items(parcel_id);

CREATE TABLE parcel_photos (
  id          INTEGER PRIMARY KEY,
  parcel_id   INTEGER NOT NULL REFERENCES parcels(id),
  mime        TEXT NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_parcel_photos_parcel ON parcel_photos(parcel_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('wh_cost_fen_per_kg', '7000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('direct_sale_fen_per_kg', '8000');
