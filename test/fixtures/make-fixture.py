#!/usr/bin/env python3
"""
手工拼一个 .xlsx，尽量贴近 Excel（在线版）保存出来的样子：

  - 图片列是 =_xlfn.IMAGE("https://…")，单元格缓存值是 #VALUE!（Excel 会这么存新函数）
  - 另一行用老写法 =IMAGE("…")
  - 商品链接列有一个「只有超链接、没有文字」的空单元格
  - 还有一行是纯文本链接

用来验证前端 collectCellUrls 能不能把地址捞出来。重新生成：
  python3 test/fixtures/make-fixture.py
"""
import zipfile, pathlib

HEADERS = ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn', '应付人民币金额']
SHARED = HEADERS + ['手办A', '手办B', '阿狸', '小明', 'https://www.suruga-ya.jp/product/detail/2']


def si(text: str) -> str:
    return f'<si><t xml:space="preserve">{text}</t></si>'


def cell_s(ref, idx):            # 共享字符串
    return f'<c r="{ref}" t="s"><v>{idx}</v></c>'


def cell_n(ref, value):          # 数字
    return f'<c r="{ref}"><v>{value}</v></c>'


def cell_formula_err(ref, formula):   # 新函数：有公式，缓存值是错误
    return f'<c r="{ref}" t="e"><f>{formula}</f><v>#VALUE!</v></c>'


def cell_empty(ref):             # 只有超链接、没有内容的空单元格
    return f'<c r="{ref}"/>'


rows = []
rows.append('<row r="1">' + ''.join(cell_s(f'{c}1', i) for i, c in enumerate('ABCDEFG')) + '</row>')

# 第 2 行：_xlfn.IMAGE 公式 + 只有超链接的空单元格
rows.append(
    '<row r="2">'
    + cell_s('A2', SHARED.index('手办A'))
    + cell_formula_err('B2', '_xlfn.IMAGE("https://img.example.com/a.png",,0)')
    + cell_empty('C2')
    + cell_n('D2', 3000)
    + cell_n('E2', 1800)
    + cell_s('F2', SHARED.index('阿狸'))
    + cell_n('G2', '98.5')
    + '</row>'
)
# 第 3 行：老写法 IMAGE 公式 + 纯文本链接
rows.append(
    '<row r="3">'
    + cell_s('A3', SHARED.index('手办B'))
    + cell_formula_err('B3', 'IMAGE("https://img.example.com/b.png")')
    + cell_s('C3', SHARED.index('https://www.suruga-ya.jp/product/detail/2'))
    + cell_n('D3', 2000)
    + cell_n('E3', 1500)
    + cell_s('F3', SHARED.index('小明'))
    + cell_n('G3', 80)
    + '</row>'
)

sheet = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:G3"/><sheetData>{''.join(rows)}</sheetData>
<hyperlinks><hyperlink ref="C2" r:id="rId1"/></hyperlinks>
</worksheet>'''

sheet_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
 Target="https://www.suruga-ya.jp/product/detail/1" TargetMode="External"/>
</Relationships>'''

workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="第12团" sheetId="1" r:id="rId1"/></sheets></workbook>'''

workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

shared = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(SHARED)}" uniqueCount="{len(SHARED)}">'
    + ''.join(si(t) for t in SHARED)
    + '</sst>'
)

styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs>
</styleSheet>'''

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''

root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

out = pathlib.Path(__file__).with_name('online-excel-image.xlsx')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', root_rels)
    z.writestr('xl/workbook.xml', workbook)
    z.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
    z.writestr('xl/sharedStrings.xml', shared)
    z.writestr('xl/styles.xml', styles)
    z.writestr('xl/worksheets/sheet1.xml', sheet)
    z.writestr('xl/worksheets/_rels/sheet1.xml.rels', sheet_rels)
print(f'wrote {out} ({out.stat().st_size} bytes)')
