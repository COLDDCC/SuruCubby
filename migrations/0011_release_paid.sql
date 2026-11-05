-- 以前在客户详情页 / 首页待办里收货款只记了「已付」，没放行，客户自己的页面上一直看不到。
-- 已经收过货款的东西一律补上放行时间。
UPDATE items SET released_at = COALESCE(updated_at, created_at) WHERE goods_paid = 1 AND released_at IS NULL;
