-- 两条发货路线：拼团（装回国箱，回国后称重分摊、国内寄出）和直邮（日本仓直接寄给客户）。
-- 已有的物品全部视为拼团，流程不变。

-- 一个直邮包裹 = 一个国际单号。运费 = ⌈重量克 × 单价 ÷ 1000⌉，单价在称重时存档。
CREATE TABLE direct_parcels (
  id               INTEGER PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  address_snapshot TEXT NOT NULL,               -- 打包那一刻的收货地址（JSON），之后客户改地址不影响
  address_source   TEXT NOT NULL CHECK (address_source IN ('import', 'customer')),
  status           TEXT NOT NULL DEFAULT 'packing'
                   CHECK (status IN ('packing', 'awaiting_payment', 'paid', 'shipped', 'delivered')),
  weight_g         INTEGER,
  rate_fen_per_kg  INTEGER,
  fee_fen          INTEGER,
  carrier          TEXT,
  tracking_no      TEXT,
  packed_by        TEXT,
  shipped_by       TEXT,
  created_at       TEXT NOT NULL,
  weighed_at       TEXT,
  paid_at          TEXT,
  shipped_at       TEXT,
  delivered_at     TEXT
);
CREATE INDEX idx_direct_parcels_customer ON direct_parcels(customer_id);
CREATE INDEX idx_direct_parcels_status ON direct_parcels(status);

ALTER TABLE items ADD COLUMN route TEXT NOT NULL DEFAULT 'group' CHECK (route IN ('group', 'direct'));
ALTER TABLE items ADD COLUMN import_address TEXT;
ALTER TABLE items ADD COLUMN direct_parcel_id INTEGER REFERENCES direct_parcels(id);
CREATE INDEX idx_items_route_status ON items(route, status);
CREATE INDEX idx_items_direct_parcel ON items(direct_parcel_id);

-- 客户在自己页面上选的「直邮寄到哪个地址」；地址删掉后自然失效（不加外键，免得删地址报错）
ALTER TABLE customers ADD COLUMN direct_address_id INTEGER;

INSERT OR IGNORE INTO settings (key, value) VALUES ('direct_price_fen_per_kg', '12000');
