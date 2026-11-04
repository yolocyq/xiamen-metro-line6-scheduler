# -*- coding: utf-8 -*-
"""把 seed.json(748KB) 压缩为 seedc.js(~20KB)：
   - 班次/岗位/角色/性质 全部字典化为索引
   - 证书转位串（对齐 meta.certTypes）
   - base 单元格：休息=null，纯班次=班次索引数字，带标注=数组
   - 整体 JSON -> zlib deflate -> base64，浏览器端 DecompressionStream 还原
   还原后与原 seed.json 结构完全一致（node 等价性测试保证）"""
import json, zlib, base64, re

d = json.load(open('seed.json', encoding='utf-8'))
dates = d['meta']['dates']
shift_codes = d['meta']['shiftCodes']
cert_types = d['meta']['certTypes']

# id 连续性检查（e1..eN 则可推导，省空间）
ids = [e['id'] for e in d['employees']]
seq_ok = all(ids[i] == f'e{i+1}' for i in range(len(ids)))
assert seq_ok, f"id 不连续，需保留: {ids[:5]}..."

posts = sorted({e['post'] for e in d['employees']})
roles = sorted({e['role'] for e in d['employees']})
types = sorted({e['type'] for e in d['employees']})

def compact_cell(c):
    if c.get('isRest'):
        return None
    code, intended = c.get('code'), c.get('intended')
    rest = (c.get('leaveType'), c.get('substitute'), c.get('dispatchedTo'),
            c.get('replace'), c.get('annotation'))
    ci = shift_codes.index(code) if code is not None else None
    ii = shift_codes.index(intended) if intended is not None else None
    if not any(rest):
        if c.get('raw') == code and intended == code:
            return ci                                   # 纯班次
        return [c.get('raw'), ci, ii, None, None, None, None, None]
    return [c.get('raw'), ci, ii, *rest]

emps = []
for e in d['employees']:
    assert set(e['base'].keys()) == set(dates)
    emps.append([
        e['name'],                                  # 0 姓名
        [s['id'] for s in d['sections']].index(e['sectionId']),   # 1 站索引
        posts.index(e['post']),                     # 2 岗位
        roles.index(e['role']),                     # 3 角色
        types.index(e['type']),                     # 4 性质
        e['workno'] or '',                          # 5 工号
        ''.join('1' if e['certs'].get(ct) else '0' for ct in cert_types),  # 6 证书位串
        [compact_cell(e['base'][dt]) for dt in dates],                     # 7 每日
    ])

sections = [[s['id'], s['name'], s['kind']] for s in d['sections']]
compact = {
    'm': {'dates': dates, 'certTypes': cert_types, 'shiftCodes': shift_codes},
    's': sections, 'd': {'post': posts, 'role': roles, 'type': types}, 'e': emps,
}
raw = json.dumps(compact, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
b64 = base64.b64encode(zlib.compress(raw, 9)).decode('ascii')
lines = [b64[i:i+96] for i in range(0, len(b64), 96)]

seedc = '''/* 6号线排班数据（紧凑压缩版，由 make_compact_seed.py 生成，含内置还原逻辑）
   加载后 window.LINE6_SEED_PROMISE resolve 出与完整版一致的数据结构 */
(function () {
  var B64 = [%s].join("\\n");
  function expand(j) {
    var dates = j.m.dates, sc = j.m.shiftCodes, ct = j.m.certTypes;
    function cell(x) {
      if (x === null) return { raw: '', code: null, intended: null, leaveType: null,
        substitute: null, dispatchedTo: null, replace: null, annotation: null, isRest: true };
      if (typeof x === 'number') return { raw: sc[x], code: sc[x], intended: sc[x],
        leaveType: null, substitute: null, dispatchedTo: null, replace: null,
        annotation: null, isRest: false };
      return { raw: x[0], code: x[1] === null ? null : sc[x[1]],
        intended: x[2] === null ? null : sc[x[2]], leaveType: x[3], substitute: x[4],
        dispatchedTo: x[5], replace: x[6], annotation: x[7], isRest: false };
    }
    var secs = j.s.map(function (a) { return { id: a[0], name: a[1], kind: a[2] }; });
    var emps = j.e.map(function (a, i) {
      var b = {};
      dates.forEach(function (dt, k) { b[dt] = cell(a[7][k]); });
      var certs = {};
      ct.forEach(function (t, k) { certs[t] = a[6].charAt(k) === '1'; });
      return { id: 'e' + (i + 1), sectionId: j.s[a[1]][0], sectionName: j.s[a[1]][1],
        name: a[0], post: j.d.post[a[2]], role: j.d.role[a[3]], type: j.d.type[a[4]],
        workno: a[5], certs: certs, base: b };
    });
    return { meta: j.m, sections: secs, employees: emps };
  }
  window.LINE6_SEED_PROMISE = (async function () {
    var bin = atob(B64.replace(/\\s+/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    var seed = expand(JSON.parse(await new Response(stream).text()));
    window.LINE6_SEED = seed;
    return seed;
  })();
})();
''' % (',\n    '.join('"%s"' % l for l in lines))

open('seedc.js', 'w', encoding='utf-8').write(seedc)
import os
print('紧凑JSON: %d B | deflate+base64: %d B | seedc.js: %d B (原 765,660 B)'
      % (len(raw), len(b64), os.path.getsize('seedc.js')))
