-- 货款改为日元记账：汇率波动由客户在付款时自行换算，群主不预先折成人民币。
-- 运费（国际、国内）仍然是人民币分，所以 payments 必须显式记币种，两种钱不能相加。
ALTER TABLE items RENAME COLUMN goods_fee_fen TO goods_fee_jpy;
ALTER TABLE payments RENAME COLUMN amount_fen TO amount;
ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY';
UPDATE payments SET currency = 'JPY' WHERE kind = 'goods';
