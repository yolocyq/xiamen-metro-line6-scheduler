/* 6号线排班数据（紧凑压缩版，由 make_compact_seed.py 生成，含内置还原逻辑）
   加载后 window.LINE6_SEED_PROMISE resolve 出与完整版一致的数据结构 */
(function () {
  var B64 = ["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",
    "PRYTl6xUb5/Hf/k//rahxw=="].join("\n");
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
    var bin = atob(B64.replace(/\s+/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    var seed = expand(JSON.parse(await new Response(stream).text()));
    window.LINE6_SEED = seed;
    return seed;
  })();
})();
