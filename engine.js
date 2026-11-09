/*
 * line6 排班引擎：基础班次 + 顶替逻辑
 * 贴合厦门地铁6号线人工表语义：
 *   - 每人有"应排班次"(intended)。原表已含完整顶替结果。
 *   - 本人行空缺记法： X替 / 班次（假种，X替）
 *   - 顶替人行记法：   班次（目标站，替原人）
 *   - 顶替优先级：同岗备班 → 同站正岗 → 跨站正岗（多备班随机）
 *   - 同角色才能互替：站务员↔站务员，行值↔行值，值站↔值站
 *   - 无用户改动 → 直接沿用原表（一键确认）
 */
(function (global) {
  'use strict';

  const HOURS_PER_SHIFT = 8;
  const OVERTIME_HOURS = 48;            // 8天内超过即预警（≈6个班）
  const ROLE_ORDER = { '值站': 3, '行值': 2, '站务员': 1, '管理': 0, '其他': 0 };

  // —— 可调整配置（依公司规定后续修改）——
  const FORCED_REST_MAX_CONSEC = 7;     // 连续出勤超过此天数 → 强制休息标记（意见10，仅做标记防遗忘）
  const NIGHT_RULES = [                 // 意见8 夜班认定：按班次代号前缀判定（可按实际代号规则调整）
    { test: /^KB/,  kind: '大夜' },       // KB 开头 = 大夜
    { test: /^KA7|^K7/, kind: '小夜' },   // KA7 开头 = 小夜
  ];
  const SPECIAL_STATUSES = ['孕期', '哺乳期'];   // 意见11：不能上夜班的特殊时期

  function nightKind(code) {
    if (!code) return null;
    for (const r of NIGHT_RULES) { if (r.test.test(code)) return r.kind; }
    return null;
  }
  function isSpecialStatus(e) { return e && SPECIAL_STATUSES.includes(e.status); }

  function sameRole(a, b) { return a === b; }
  function requiredCerts(role) {
    if (role === '站务员') return ['上岗证'];
    if (role === '行值') return ['上岗证'];
    if (role === '值站') return ['上岗证'];
    return [];
  }
  function hasCerts(emp, reqs) { return reqs.every(c => emp.certs && emp.certs[c]); }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function restCell() {
    return { text: '', code: null, isAbsent: false, isSubstitute: false,
      dispatchedTo: null, replace: null, leaveType: null, substitute: null,
      annotation: null, isRest: true, sameAsBase: true };
  }

  // 取某人某天"应排班次"（优先自身，否则从原表替班人反推）
  function intendedShift(emp, date, baseSubCode) {
    const cell = emp.base[date];
    if (!cell) return null;
    if (cell.isRest) return null;
    if (cell.intended || cell.code) return cell.intended || cell.code;
    // 本人行是 "（X替）" 无班次：用原表替班人当天的班次
    if (baseSubCode && baseSubCode[emp.id] && baseSubCode[emp.id][date]) {
      return baseSubCode[emp.id][date];
    }
    return null;
  }

  // 是否空缺(需被顶)：原表有替班人/休假标注，或用户新增休假
  function holeInfo(emp, date, overrides) {
    const ov = overrides[emp.id] && overrides[emp.id][date];
    if (ov && ov.leave) return { absent: true, leave: ov.leave };
    const cell = emp.base[date];
    if (cell && (cell.substitute || cell.leaveType)) {
      return { absent: true, leave: cell.leaveType || null };
    }
    return { absent: false, leave: null };
  }

  // 构建：baseSubCode[empId][date] = 原表替班人当天所用班次（用于反推空缺班次）
  function buildBaseSubCode(state) {
    const map = {};
    state.employees.forEach(e => {
      state.dates.forEach(d => {
        const c = e.base[d];
        if (c && c.replace) {
          // 找 base 中 dispatchedTo 指向 e.sectionName 且 replace===e.name 的人
          const sub = state.employees.find(s =>
            s.base[d] && s.base[d].replace === e.name &&
            (s.base[d].dispatchedTo === e.sectionName || !s.base[d].dispatchedTo));
          if (sub && (sub.base[d].code)) {
            map[e.id] = map[e.id] || {};
            map[e.id][d] = sub.base[d].code;
          }
        }
      });
    });
    return map;
  }

  function hasOverrides(overrides) {
    return overrides && Object.keys(overrides).length > 0;
  }

  // 意见1 换班/顶岗：override {subBy: 顶岗人id}
  // A 的班次由 B 顶；仅当 B 当天无自身班次且空闲时可用；双向换班=登记两条
  function applySwaps(state, overrides, schedule, used, warnings, stats, baseSubCode) {
    const { employees, dates } = state;
    const dateSet = new Set(dates);
    Object.keys(overrides).forEach(aid => {
      Object.keys(overrides[aid] || {}).forEach(d => {
        const ov = overrides[aid][d];
        if (!ov || !ov.subBy || !dateSet.has(d)) return;
        const A = employees.find(e => e.id === aid);
        const B = employees.find(e => e.id === ov.subBy);
        if (!A || !B || A.id === B.id) return;
        const cellA = schedule[A.id] && schedule[A.id][d];
        const intended = intendedShift(A, d, baseSubCode) || (A.base[d] && A.base[d].code);
        if (!cellA || !intended) return;
        if (cellA.swapBy) return;                         // 已被另一次换班覆盖
        const bc = B.base ? B.base[d] : null;
        const bBusyOwn = bc && bc.code && !bc.isRest;     // B 当天自身有班
        const bAbsent = bc && (bc.substitute || bc.leaveType); // B 当天休假/被替
        if (bBusyOwn || bAbsent || used[d].has(B.id)) {
          warnings.push({ type: 'swap', level: 'error',
            message: `换班失败：${A.name}（${d.slice(5)}）→ ${B.name}${bAbsent ? ' 当天休假/被替' : bBusyOwn ? ' 当天自身有班' : ' 已被其他顶替占用'}，请换其他顶岗人` });
          return;
        }
        used[d].add(B.id); stats.substituted++; stats.swaps++;
        schedule[A.id][d] = Object.assign({}, cellA, {
          text: `${intended}（换班·${B.name}顶岗）`, swapBy: B.name, sameAsBase: false });
        schedule[B.id][d] = Object.assign({}, schedule[B.id][d] || restCell(), {
          text: `${intended}（替${A.name}换班）`, code: intended, isRest: false, isAbsent: false,
          isSubstitute: true, dispatchedTo: A.sectionName, replace: A.name,
          leaveType: null, swapFor: A.name, sameAsBase: false });
        if (isSpecialStatus(B) && nightKind(intended)) {
          warnings.push({ type: 'night', level: 'warn',
            message: `${B.name}（${B.status}）被安排夜班 ${intended}（替${A.name}换班），请留意` });
        }
      });
    });
  }

  // 意见10 强制休息标记：连续出勤超过阈值仅做提醒（防遗忘，标准依公司规定可调）
  function checkForcedRest(employees, dates, schedule, warnings) {
    employees.forEach(e => {
      let run = 0, maxRun = 0;
      dates.forEach(d => {
        const c = schedule[e.id][d];
        if (c && c.code && !c.isRest && !c.isAbsent) { run++; if (run > maxRun) maxRun = run; }
        else run = 0;
      });
      if (maxRun > FORCED_REST_MAX_CONSEC) {
        warnings.push({ type: 'rest', level: 'warn',
          message: `${e.sectionName}·${e.post} ${e.name} 连续出勤 ${maxRun} 天（>${FORCED_REST_MAX_CONSEC}），触及强制休息标记（阈值依公司规定可调）` });
      }
    });
  }

  // 输出"沿用原表"结果
  function baseOutput(state, sig) {
    const schedule = {};
    const stats = { totalShifts: 0, perEmpHours: {}, reserveUsed: 0, crossStation: 0, substituted: 0 };
    state.employees.forEach(e => {
      schedule[e.id] = {};
      let h = 0;
      state.dates.forEach(d => {
        const c = e.base[d];
        if (!c) { schedule[e.id][d] = restCell(); return; }
        schedule[e.id][d] = {
          text: c.raw || '', code: c.code, isAbsent: !!c.substitute || !!c.leaveType,
          isSubstitute: !!c.dispatchedTo, dispatchedTo: c.dispatchedTo, replace: c.replace,
          leaveType: c.leaveType, substitute: c.substitute, annotation: c.annotation,
          isRest: c.isRest, sameAsBase: true
        };
        if (c.code && !c.isRest) h += HOURS_PER_SHIFT;
      });
      stats.perEmpHours[e.id] = h;
    });
    stats.totalShifts = state.employees.reduce(
      (a, e) => a + state.dates.filter(d => schedule[e.id][d].code && !schedule[e.id][d].isRest).length, 0);
    const restWarnings = [];
    checkForcedRest(state.employees, state.dates, schedule, restWarnings);
    return { schedule, warnings: dedupe(restWarnings), stats, noChange: true, inputSig: sig,
      note: '无人员/班次变动，已沿用上次排班（原表）。' };
  }

  function generate(state, overrides, lastInputHash, mode) {
    overrides = overrides || {};
    mode = mode || 'precise';   // 'precise' = 仅重排用户新增空缺; 'reflow' = 全量重排(结构性变动)
    const { employees, dates } = state;
    const baseSubCode = buildBaseSubCode(state);

    const inputSig = JSON.stringify([
      employees.map(e => [e.id, e.type, e.sectionId, e.post,
        dates.map(d => (e.base[d] ? (e.base[d].leaveType || e.base[d].substitute || '') : 'R'))]),
      overrides
    ]);
    const noChange = lastInputHash && lastInputHash === inputSig;

    // 无任何用户改动 → 直接用原表
    if (!hasOverrides(overrides) && noChange) return baseOutput(state, inputSig);
    if (!hasOverrides(overrides)) return baseOutput(state, inputSig);

    if (mode === 'reflow') return reflowAll(state, overrides, baseSubCode, inputSig);

    // ---- 有改动(precise)：以原表为底板，仅重排"用户实际改动"的空缺 ----
    const schedule = {};
    const used = {};                 // used[date] = Set(已被占用的人)
    const warnings = [];
    const stats = { totalShifts: 0, perEmpHours: {}, reserveUsed: 0, crossStation: 0, substituted: 0, swaps: 0 };
    dates.forEach(d => used[d] = new Set());

    // 1) 底板 = 原表（原样复制，包括原表的顶替对）
    employees.forEach(e => {
      schedule[e.id] = {};
      dates.forEach(d => {
        const c = e.base[d];
        if (!c) { schedule[e.id][d] = restCell(); return; }
        schedule[e.id][d] = {
          text: c.raw || '', code: c.code, isAbsent: !!c.substitute || !!c.leaveType,
          isSubstitute: !!c.dispatchedTo, dispatchedTo: c.dispatchedTo, replace: c.replace,
          leaveType: c.leaveType, substitute: c.substitute, annotation: c.annotation,
          isRest: c.isRest, sameAsBase: true
        };
        // 原表中已是"顶替人"的，当天占用
        if (c.dispatchedTo) used[d].add(e.id);
      });
    });

    // 1.5) 换班/顶岗登记（意见1）
    applySwaps(state, overrides, schedule, used, warnings, stats, baseSubCode);

    // 2) 找出需要新顶替的空缺：用户新增休假/base 变动，且原表该天此人不空缺
    dates.forEach(d => {
      const onLeave = new Set();
      employees.forEach(e => {
        const hi = holeInfo(e, d, overrides);
        if (hi.absent) onLeave.add(e.id);
      });
      // 新增空缺 = 用户 override.leave 且 原表该天此人不空缺
      const newHoles = employees.filter(e => {
        const ov = overrides[e.id] && overrides[e.id][d];
        if (!ov || !ov.leave) return false;
        const bc = e.base[d];
        const already = bc && (bc.substitute || bc.leaveType);
        return !already;
      });

      newHoles.forEach(hole => {
        const intended = intendedShift(hole, d, baseSubCode) || (hole.base[d] && hole.base[d].code);
        if (!intended) return;
        const cands = employees.filter(s =>
          sameRole(s.role, hole.role) &&
          !onLeave.has(s.id) && !used[d].has(s.id) &&
          s.id !== hole.id &&
          hasCerts(s, requiredCerts(hole.role)));
        if (cands.length === 0) {
          schedule[hole.id][d] = { text: `${intended}（待安排）`, code: intended,
            isAbsent: true, isSubstitute: false, dispatchedTo: null, replace: null,
            leaveType: overrides[hole.id][d].leave, substitute: null,
            annotation: null, isRest: false, isWarning: true, sameAsBase: false };
          warnings.push({ type: 'unstaffed', level: 'error',
            message: `${hole.sectionName}·${hole.post} ${hole.name}（${d}）无同岗合格人员可顶替` });
          return;
        }
        // 备班优先；同站正岗；跨站正岗；多备班随机
        const reserve = cands.filter(s => s.type === '备班');
        const sameSta = cands.filter(s => s.type !== '备班' && s.sectionId === hole.sectionId);
        const cross   = cands.filter(s => s.type !== '备班' && s.sectionId !== hole.sectionId);
        let pick, kind;
        if (reserve.length)      { pick = shuffle(reserve)[0]; kind='reserve'; stats.reserveUsed++; }
        else if (sameSta.length) { pick = shuffle(sameSta)[0]; kind='same'; }
        else if (cross.length)   { pick = shuffle(cross)[0];   kind='cross'; stats.crossStation++; }
        else                     { pick = shuffle(cands)[0];   kind='other'; }
        used[d].add(pick.id); stats.substituted++;

        const lv = overrides[hole.id][d].leave;
        schedule[hole.id][d] = {
          text: `${intended}（${lv}，${pick.name}替）`,
          code: intended, isAbsent: true, isSubstitute: false,
          dispatchedTo: null, replace: null, leaveType: lv, substitute: pick.name,
          annotation: null, isRest: false, sameAsBase: false
        };
        const pickIntended = intendedShift(pick, d, baseSubCode) || intended;
        schedule[pick.id][d] = {
          text: `${pickIntended}（${hole.sectionName}，替${hole.name}）`,
          code: pickIntended, isAbsent: false, isSubstitute: true,
          dispatchedTo: hole.sectionName, replace: hole.name,
          leaveType: null, substitute: null, annotation: null, isRest: false, sameAsBase: false
        };
        const miss = requiredCerts(hole.role).filter(c => !pick.certs[c]);
        if (miss.length) warnings.push({ type:'cert', level:'warn',
          message:`顶替资质缺口：${pick.sectionName}·${pick.post} ${pick.name} 替 ${hole.name} 缺【${miss.join('、')}】` });
        if (isSpecialStatus(pick) && nightKind(intended)) warnings.push({ type:'night', level:'warn',
          message:`${pick.name}（${pick.status}）被安排夜班 ${intended}（替${hole.name}），请留意` });
        if (kind==='cross') warnings.push({ type:'crossgap', level:'warn',
          message:`${pick.sectionName}·${pick.post} ${pick.name} 被抽至${hole.sectionName}顶替，${pick.sectionName}当日${pick.post}空缺` });
      });
    });

    checkForcedRest(employees, dates, schedule, warnings);

    // 工时统计 + 超限告警
    employees.forEach(e => {
      let h = 0;
      dates.forEach(d => { const c = schedule[e.id][d]; if (c.code && !c.isRest) h += HOURS_PER_SHIFT; });
      stats.perEmpHours[e.id] = h;
      if (h > OVERTIME_HOURS) {
        warnings.push({ type: 'overtime', level: 'warn',
          message: `${e.sectionName}·${e.post} ${e.name} 周期内 ${h}h（>${OVERTIME_HOURS}h），建议调休` });
      }
    });
    stats.totalShifts = employees.reduce(
      (a, e) => a + dates.filter(d => schedule[e.id][d].code && !schedule[e.id][d].isRest).length, 0);

    return { schedule, warnings: dedupe(warnings), stats,
      noChange: false, inputSig,
      note: '已根据变动重排，顶替优先级：同岗备班→同站正岗→跨站正岗（多备班随机）。' };
  }

  // 全量重排：以原表为底板，对所有空缺重算顶替，尽量沿用原表顶替人（结构性变动时使用）
  function reflowAll(state, overrides, baseSubCode, inputSig) {
    const { employees, dates } = state;
    const schedule = {};
    const used = {}; dates.forEach(d => used[d] = new Set());
    const warnings = [];
    const stats = { totalShifts: 0, perEmpHours: {}, reserveUsed: 0, crossStation: 0, substituted: 0, swaps: 0 };

    // 底板 = 原表
    employees.forEach(e => {
      schedule[e.id] = {};
      dates.forEach(d => {
        const c = e.base[d];
        if (!c) { schedule[e.id][d] = restCell(); return; }
        schedule[e.id][d] = {
          text: c.raw || '', code: c.code, isAbsent: !!c.substitute || !!c.leaveType,
          isSubstitute: !!c.dispatchedTo, dispatchedTo: c.dispatchedTo, replace: c.replace,
          leaveType: c.leaveType, substitute: c.substitute, annotation: c.annotation,
          isRest: c.isRest, sameAsBase: true
        };
        if (c.dispatchedTo) used[d].add(e.id);
      });
    });

    // 换班/顶岗登记（意见1）
    applySwaps(state, overrides, schedule, used, warnings, stats, baseSubCode);

    dates.forEach(d => {
      const onLeave = new Set();
      employees.forEach(e => { if (holeInfo(e, d, overrides).absent) onLeave.add(e.id); });

      // 空缺 = 原表有替班/休假标注 或 用户新增休假，且应有班次
      const holes = employees.filter(e => {
        const hi = holeInfo(e, d, overrides);
        return hi.absent && intendedShift(e, d, baseSubCode) && !used[d].has(e.id);
      });
      const baseSubName = {};
      holes.forEach(h => { const c = h.base[d]; if (c && c.substitute) baseSubName[h.id] = c.substitute; });

      let guard = 0;
      while (holes.length && guard++ < employees.length * 2) {
        const hole = holes.shift();
        if (used[d].has(hole.id)) continue;
        const intended = intendedShift(hole, d, baseSubCode);
        if (!intended) continue;
        const lv = holeInfo(hole, d, overrides).leave;

        const cands = employees.filter(s =>
          sameRole(s.role, hole.role) && !onLeave.has(s.id) && !used[d].has(s.id) &&
          s.id !== hole.id && hasCerts(s, requiredCerts(hole.role)));

        if (cands.length === 0) {
          schedule[hole.id][d] = { text: `${intended}（待安排）`, code: intended, isAbsent: true,
            isSubstitute: false, dispatchedTo: null, replace: null, leaveType: lv, substitute: null,
            annotation: null, isRest: false, isWarning: true, sameAsBase: false };
          warnings.push({ type: 'unstaffed', level: 'error',
            message: `${hole.sectionName}·${hole.post} ${hole.name}（${d}）无同岗合格人员可顶替` });
          continue;
        }
        const reserve = cands.filter(s => s.type === '备班');
        const sameSta = cands.filter(s => s.type !== '备班' && s.sectionId === hole.sectionId);
        const cross   = cands.filter(s => s.type !== '备班' && s.sectionId !== hole.sectionId);
        let pick, kind;
        const pref = reserve.find(s => s.name === baseSubName[hole.id]);
        if (reserve.length)      { pick = pref || shuffle(reserve)[0]; kind='reserve'; stats.reserveUsed++; }
        else if (sameSta.length) { pick = shuffle(sameSta)[0]; kind='same'; }
        else if (cross.length)   { pick = shuffle(cross)[0];   kind='cross'; stats.crossStation++; }
        else                     { pick = shuffle(cands)[0];   kind='other'; }
        used[d].add(pick.id); stats.substituted++;

        schedule[hole.id][d] = {
          text: `${intended}（${lv ? lv + '，' : ''}${pick.name}替）`, code: intended,
          isAbsent: true, isSubstitute: false, dispatchedTo: null, replace: null,
          leaveType: lv, substitute: pick.name, annotation: null, isRest: false, sameAsBase: (cands.length===1 && pref)
        };
        const pickIntended = intendedShift(pick, d, baseSubCode) || intended;
        schedule[pick.id][d] = {
          text: `${pickIntended}（${hole.sectionName}，替${hole.name}）`, code: pickIntended,
          isAbsent: false, isSubstitute: true, dispatchedTo: hole.sectionName, replace: hole.name,
          leaveType: null, substitute: null, annotation: null, isRest: false, sameAsBase: false
        };
        const miss = requiredCerts(hole.role).filter(c => !pick.certs[c]);
        if (miss.length) warnings.push({ type:'cert', level:'warn',
          message:`顶替资质缺口：${pick.sectionName}·${pick.post} ${pick.name} 替 ${hole.name} 缺【${miss.join('、')}】` });
        if (isSpecialStatus(pick) && nightKind(intended)) warnings.push({ type:'night', level:'warn',
          message:`${pick.name}（${pick.status}）被安排夜班 ${intended}（替${hole.name}），请留意` });
        if (kind==='cross') warnings.push({ type:'crossgap', level:'warn',
          message:`${pick.sectionName}·${pick.post} ${pick.name} 被抽至${hole.sectionName}顶替，${pick.sectionName}当日${pick.post}空缺` });
      }
    });

    checkForcedRest(employees, dates, schedule, warnings);

    employees.forEach(e => {
      let h = 0;
      dates.forEach(d => { const c = schedule[e.id][d]; if (c.code && !c.isRest) h += HOURS_PER_SHIFT; });
      stats.perEmpHours[e.id] = h;
      if (h > OVERTIME_HOURS) warnings.push({ type:'overtime', level:'warn',
        message:`${e.sectionName}·${e.post} ${e.name} 周期内 ${h}h（>${OVERTIME_HOURS}h），建议调休` });
    });
    stats.totalShifts = employees.reduce(
      (a, e) => a + dates.filter(d => schedule[e.id][d].code && !schedule[e.id][d].isRest).length, 0);
    return { schedule, warnings: dedupe(warnings), stats, noChange:false, inputSig,
      note:'已全量重排（含结构性变动），顶替优先级：同岗备班→同站正岗→跨站正岗。' };
  }

  function dedupe(ws) {
    const seen = new Set(); const out = [];
    ws.forEach(w => { const k = w.type + '|' + w.message; if (!seen.has(k)) { seen.add(k); out.push(w); } });
    return out;
  }

  function addDaysISO(iso, n) {
    const [y,m,d]=iso.split('-').map(Number);
    const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+n);
    return dt.toISOString().slice(0, 10);
  }

  // 周期延续：把 templateDates 的班次循环复用到 newDates
  // keepAnnotations=true  → 原样复制（含休假/顶替标注）；
  // keepAnnotations=false → 只复用"班次旋转"（清理休假/顶替标注，新周期从干净轮班开始）
  function extendBase(employees, templateDates, newDates, opts) {
    opts = opts || {};
    const keep = !!opts.keepAnnotations;
    const cycleLen = templateDates.length;
    const sub = buildBaseSubCode({ employees, dates: templateDates });
    return employees.map(e => {
      const base = Object.assign({}, e.base);
      newDates.forEach((d, i) => {
        if (base[d]) return;
        const t = templateDates[i % cycleLen];
        const src = e.base[t];
        if (!src) return;
        if (keep) {
          base[d] = Object.assign({}, src, { sameAsBase: true });
          return;
        }
        let code = src.code || src.intended;
        if (!code) code = intendedShift(e, t, sub); // 纯"被替"格：反推替班人当天班次
        const isRest = !code && (!!src.isRest || (!src.substitute && !src.leaveType));
        base[d] = {
          raw: code || '', code: code || null,
          leaveType: null, substitute: null, dispatchedTo: null, replace: null, annotation: null,
          intended: code || null, isRest: !!isRest, sameAsBase: true
        };
      });
      return Object.assign({}, e, { base });
    });
  }

  const API = { generate, intendedShift, holeInfo, requiredCerts, HOURS_PER_SHIFT, OVERTIME_HOURS,
    FORCED_REST_MAX_CONSEC, nightKind, extendBase, addDaysISO };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.Line6Engine = API;
})(typeof window !== 'undefined' ? window : globalThis);
