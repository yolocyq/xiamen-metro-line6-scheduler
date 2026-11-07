/* 6号线排班数据（紧凑压缩版，由 make_compact_seed.py 生成，含内置还原逻辑）
   加载后 window.LINE6_SEED_PROMISE resolve 出与完整版一致的数据结构 */
(function () {
  var B64 = ["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"].join("\n");
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
        workno: a[5], certs: certs, base: b,
        mode: j.d.mode[a[8]], group: j.d.grp[a[9]] };
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
