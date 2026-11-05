-- 封面图抓取失败的原因：有值 = 自动抓过、没抓到，等群主「重抓」或手动上传。
ALTER TABLE items ADD COLUMN image_error TEXT;
