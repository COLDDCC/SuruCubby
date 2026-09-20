# 自托管 SheetJS（可选，但国内建议做）

导入页在浏览器里用 SheetJS 解析 Excel。页面会先尝试加载本目录下的
`xlsx.full.min.js`，加载不到才回退到官方 CDN
（`https://cdn.sheetjs.com/...`，国内可能很慢或打不开）。

自托管办法：

```bash
curl -o public/vendor/xlsx.full.min.js \
  https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
```

放好后重新 `wrangler deploy` 即可，页面会自动优先用本地这份。
请使用 0.20.2 及以上版本（更早的版本有已知的原型污染漏洞）。
