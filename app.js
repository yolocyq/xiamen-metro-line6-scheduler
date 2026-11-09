/* 厦门地铁6号线 智能排班 - 前端逻辑 */
(function () {
  'use strict';
  function boot(SEED) {
  const DATES = SEED.meta.dates;           // 模板周期（原 Excel 的 8 天）
  const WD = ['日','一','二','三','四','五','六'];
  function wdOf(date){ const d=new Date(date+'T00:00:00'); return WD[d.getDay()]; }

  // ---- 意见5：休假/未在岗类别（可按公司规定继续增补）----
  const LEAVE_TYPES = ['年休假','病假','事假','婚假','产假','照顾假','计生假','调休假',
    '工伤假','丧假（含路程假）','独生子女照顾父母假','孕期假','计划生育手术照顾假','育儿假'];
  const OTHER_TYPES = ['培训','借调','跟岗','其他'];
  const SPECIAL_STATUSES = ['孕期','哺乳期'];          // 意见11
  const HOUR_SYSTEMS = ['标准工时制','综合计算工时制','不定时工作制'];  // 意见3

  // ===== 2.0意见3：工时计算参数（拿到公司正式文件后，只改这三行即可）=====
  // 折算月工时 = 周期出勤工时 ÷ 周期天数 × 折算月天数
  // 周期出勤工时 = 出勤班数 × 每班工时（每班工时在 engine.js 的 HOURS_PER_SHIFT，默认 8）
  const MONTH_CONVERT_DAYS = 30;      // 折算月天数（自然月平均天数，通常 30 或 30.4）
  const STANDARD_MONTH_HOURS = 167;   // 月标准工时（法定月平均 20.83 天 × 8h ≈ 166.6，取 167）
  // 若公司按「月平均计薪天数 21.75 天」核算，把 STANDARD_MONTH_HOURS 改成 174（21.75×8）即可
  // ====================================================================
  const GROUP_COLORS = ['#7c3aed','#d81b7a','#0f766e','#b45309','#1d4ed8','#be123c','#15803d','#6d28d9'];
  function groupColor(g){ if(!g) return null;
    let h=0; for(const ch of g) h=(h*31+ch.charCodeAt(0))>>>0; return GROUP_COLORS[h%GROUP_COLORS.length]; }

  // ---- 状态 ----
  let employees = clone(SEED.employees);
  let sections = clone(SEED.sections);
  const overrides = {};            // {empId:{date:{leave}}}
  let structuralChanged = false;   // 是否改动过 性质/所属站
  let lastResult = null, lastGenSig = null;

  // 周期延续：curDates 为当前生效的日期范围（模板 + 延续）
  let curDates = DATES.slice();
  const ext = { active:false, weeks:1, keep:false };

  function addDays(iso, n){ const [y,m,d]=iso.split('-').map(Number);
    const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+n); return dt.toISOString().slice(0,10); }
  function computeNewDates(weeks){
    const out=[]; const start=addDays(DATES[DATES.length-1],1); const n=8*weeks;
    for(let i=0;i<n;i++) out.push(addDays(start,i)); return out;
  }
  // 生成"生效状态"：若已延续，则返回扩展了 base 的人员与完整日期
  function getEffective(){
    if(!ext.active) return { emps: employees, dates: DATES.slice() };
    const nd=computeNewDates(ext.weeks);
    const emps=window.Line6Engine.extendBase(employees, DATES, nd, { keepAnnotations: ext.keep });
    return { emps, dates: DATES.concat(nd) };
  }
  function updatePeriodLabel(){
    if(ext.active){
      const nd=computeNewDates(ext.weeks);
      document.getElementById('periodLabel').textContent=
        `排班周期：${DATES[0]} ~ ${nd[nd.length-1]}（原8天 + 延续${ext.weeks}周期 = ${curDates.length}天）`;
    } else {
      document.getElementById('periodLabel').textContent=
        `排班周期：${DATES[0]} ~ ${DATES[DATES.length-1]}（${DATES.length}天）`;
    }
  }

  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function byId(id){ return employees.find(e=>e.id===id); }
  function secName(id){ const s=sections.find(s=>s.id===id); return s?s.name:id; }
  function computeSig(){
    return JSON.stringify([employees.map(e=>[e.id,e.type,e.sectionId,e.role,e.group||'',e.status||'',e.hourSystem||'']), overrides]);
  }

  // ---- 初始化 ----
  function init(){
    updatePeriodLabel();
    buildSectionFilter();
    buildChangeForm();
    bindEvents();
    doGenerate(true); // 首次：呈现原表
  }

  function buildSectionFilter(){
    const sel=document.getElementById('sectionFilter');
    sel.innerHTML='<option value="">全部（整条6号线）</option>'+
      sections.map(s=>`<option value="${s.id}">${s.name}（${s.kind}）</option>`).join('');
  }

  function buildChangeForm(){
    const sel=document.getElementById('chgPerson');
    sel.innerHTML=employees.map(e=>`<option value="${e.id}">${e.sectionName} · ${e.name}（${e.post}）</option>`).join('');
    // 意见5：休假 14 类 + 其他类（培训/借调/跟岗）
    const lv=document.getElementById('chgLeave');
    lv.innerHTML='<optgroup label="休假">'+LEAVE_TYPES.map(t=>`<option>${t}</option>`).join('')+'</optgroup>'+
      '<optgroup label="其他">'+OTHER_TYPES.map(t=>`<option>${t}</option>`).join('')+'</optgroup>';
    // 意见1：换班/顶岗
    const sp=document.getElementById('chgSwapPerson'), sb=document.getElementById('chgSwapBy');
    const opts=employees.map(e=>`<option value="${e.id}">${e.sectionName} · ${e.name}（${e.post}）</option>`).join('');
    sp.innerHTML=opts; sb.innerHTML=opts;
    const dc=document.getElementById('chgDates'), sd=document.getElementById('swapDates');
    dc.className='dates'; sd.className='dates';
    dc.innerHTML=curDates.map(d=>`<label><input type="checkbox" value="${d}">${d.slice(5)}<small>周${wdOf(d)}</small></label>`).join('');
    sd.innerHTML=curDates.map(d=>`<label><input type="checkbox" value="${d}">${d.slice(5)}<small>周${wdOf(d)}</small></label>`).join('');
  }

  // ---- 生成 ----
  function doGenerate(initial){
    const sig=computeSig();
    if(lastResult && sig===lastGenSig){
      toast('✅ 无人员/班次变动，已沿用上次排班');
      renderSchedule(lastResult.schedule);
      renderAlerts(lastResult);
      return;
    }
    const eff=getEffective();
    const mode = structuralChanged ? 'reflow' : 'precise';
    const result = window.Line6Engine.generate({employees:eff.emps, sections, dates:eff.dates}, overrides, null, mode);
    lastResult=result; lastGenSig=sig; curDates=eff.dates;
    renderTopStats(result);
    renderSchedule(result.schedule);
    renderAlerts(result);
    if(!initial){
      toast(result.noChange ? '✅ 无变动，已沿用上次排班（原表）'
        : `⚡ 已生成：${result.stats.substituted} 处顶替 / ${result.warnings.length} 条告警`);
      switchTab('schedule');
    }
  }

  // ---- 顶栏统计 ----
  function renderTopStats(result){
    const reserve=employees.filter(e=>e.type==='备班').length;
    const station=sections.filter(s=>s.kind==='车站').length;
    const warn=result?result.warnings.length:0;
    const sub=result?result.stats.substituted:0;
    document.getElementById('topStats').innerHTML=
      `<span class="chip">总人数 <b>${employees.length}</b></span>`+
      `<span class="chip">备班 <b>${reserve}</b></span>`+
      `<span class="chip">车站 <b>${station}</b></span>`+
      `<span class="chip">本周期顶替 <b>${sub}</b></span>`+
      `<span class="chip">告警 <b>${warn}</b></span>`;
    document.getElementById('alertBadge').textContent=warn;
  }

  // ---- 排班表 ----
  // 意见5：在岗/未在岗分类（休假/培训/其他）
  function empStatusCat(schedule, e){
    let cat=null;
    curDates.forEach(d=>{
      const c=schedule[e.id][d];
      const lt=c && c.leaveType;
      if(!lt) return;
      if(lt==='培训') cat=cat||'train';
      else if(LEAVE_TYPES.includes(lt)) cat=cat||'leave';
      else cat=cat||'other';
    });
    return cat; // null=在岗
  }
  function renderSchedule(schedule){
    const area=document.getElementById('scheduleArea');
    const onlyCh=document.getElementById('onlyChanged').checked;
    const secFilter=document.getElementById('sectionFilter').value;
    const stFilter=document.getElementById('statusFilter').value;
    const q=(document.getElementById('schedSearch').value||'').trim();

    const emps = employees.filter(e=>{
      if(secFilter && e.sectionId!==secFilter) return false;
      if(q && !(e.name.includes(q)||e.workno.includes(q))) return false;
      if(stFilter){
        const cat=empStatusCat(schedule,e);
        if(stFilter==='onduty' && cat) return false;
        if(stFilter!=='onduty' && cat!==stFilter) return false;
      }
      return true;
    });
    const bySec={};
    emps.forEach(e=>{ (bySec[e.sectionId]=bySec[e.sectionId]||[]).push(e); });

    let html='';
    sections.forEach(sec=>{
      const list=bySec[sec.id]; if(!list||!list.length) return;
      // 仅看变动：跳过无变动的行
      const rows=list.filter(e=>{
        if(!onlyCh) return true;
        return curDates.some(d=>!schedule[e.id][d].sameAsBase);
      });
      if(!rows.length) return;
      html+=`<div class="sec-card">
        <div class="sec-head">${sec.name}<span class="kind">${sec.kind}</span>
          <span class="cnt">${rows.length} 人</span></div>
        <table class="sched"><thead><tr>
          <th class="name">姓名 / 岗位</th>`+
          curDates.map(d=>`<th class="th-date">${d.slice(5)}<small>周${wdOf(d)}</small></th>`).join('')+
        `</tr></thead><tbody>`+
        rows.map(e=>{
          const rc=roleClass(e.role);
          // 班组色标（四班倒）；三班倒无班组显灰色标签；备班/管理不标
          const gTag=e.group?`<span class="gname" style="background:${groupColor(e.group)}">${e.group}</span>`
                    :(e.mode==='三班倒'?`<span class="gname t3">三班倒</span>`:'');
          const sTag=SPECIAL_STATUSES.includes(e.status)?`<span class="status-tag">${e.status}·禁夜班</span>`:'';
          const cells=curDates.map(d=>{
            const c=schedule[e.id][d];
            const cls=cellClass(c)+( (onlyCh && !c.sameAsBase)?' changed':'');
            const mini = c.leaveType?`<span class="mini">${c.leaveType}</span>`:(c.dispatchedTo?`<span class="mini">${c.dispatchedTo}</span>`:'');
            return `<td class="cell ${cls}">${c.text||''}${mini}</td>`;
          }).join('');
          return `<tr><td class="name">${e.name}<span class="role-tag rt-${rc}">${e.role}</span>${gTag}${sTag}
              <div class="mini" style="color:#9aa6b2">${e.post}</div></td>${cells}</tr>`;
        }).join('')+
        `</tbody></table></div>`;
    });
    area.innerHTML = html || '<div class="empty">无匹配人员</div>';
  }
  function cellClass(c){
    if(c.isWarning) return 'warn';
    if(c.swapBy) return 'swap';
    if(c.isSubstitute) return 'sub';
    if(c.isAbsent) return 'leave';
    if(c.isRest) return 'rest';
    return 'normal';
  }
  function roleClass(r){ return r==='站务员'?'站务员':r==='行值'?'行值':r==='值站'?'值站':'管理'; }

  // ---- 人员管理 ----
  function allGroups(){
    const set=new Set();
    employees.forEach(e=>{ if(e.group) set.add(e.group); });
    return [...set];
  }
  function renderPeople(){
    const area=document.getElementById('peopleArea');
    const t=document.getElementById('peopleType').value;
    const r=document.getElementById('peopleRole').value;
    const q=(document.getElementById('peopleSearch').value||'').trim();
    const list=employees.filter(e=>{
      if(t&&e.type!==t)return false;
      if(r&&e.role!==r)return false;
      if(q&&!(e.name.includes(q)||e.workno.includes(q)||e.post.includes(q)))return false;
      return true;
    });
    const groups=allGroups();
    const groupOpts=g=>`<option value="">未分组</option>`+groups.map(x=>`<option ${x===g?'selected':''}>${x}</option>`).join('')+`<option value="__new__">＋ 新建班组…</option>`;
    area.innerHTML=list.map(e=>{
      const secOpts=sections.map(s=>`<option value="${s.id}" ${s.id===e.sectionId?'selected':''}>${s.name}</option>`).join('');
      const roleOpts=['值站','行值','站务员','管理'].map(x=>`<option ${x===e.role?'selected':''}>${x}</option>`).join('');
      // 2.0意见1：显式「非特殊时期」选项，可一键清除孕期/哺乳期标记
      const statusOpts=`<option value="" ${!e.status?'selected':''}>非特殊时期</option>`
        +SPECIAL_STATUSES.map(x=>`<option ${x===e.status?'selected':''}>${x}</option>`).join('');
      const hourOpts=HOUR_SYSTEMS.map(x=>`<option ${x===(e.hourSystem||'标准工时制')?'selected':''}>${x}</option>`).join('');
      const certs=SEED.meta.certTypes.map(ct=>{
        const on=e.certs[ct]; return `<span class="cert ${on?'on':''}">${ct}${on?'✓':''}</span>`;
      }).join('');
      const gTag=e.group?`<span class="gname" style="background:${groupColor(e.group)}">${e.group}</span>`
                :(e.mode==='三班倒'?`<span class="gname t3">三班倒</span>`:'');
      const sTag=SPECIAL_STATUSES.includes(e.status)?`<span class="status-tag">${e.status}·禁夜班</span>`:'';
      return `<div class="pcard ${e.type==='备班'?'is-reserve':''}">
        <h4>${e.name}<span class="role-tag rt-${roleClass(e.role)}">${e.role}</span>
          ${e.type==='备班'?'<span class="role-tag" style="background:#fff3e0;color:#e65100">备班</span>':''}${gTag}${sTag}</h4>
        <div class="meta">${secName(e.sectionId)} · ${e.post} · 工号 ${e.workno} · ${e.hourSystem||'标准工时制'}</div>
        <div class="certs">${certs}</div>
        <div class="row">
          <button class="toggle ${e.type==='备班'?'reserve':''}" data-act="toggle" data-id="${e.id}">
            ${e.type==='备班'?'恢复正岗':'设为备班'}</button>
          <button class="toggle" data-act="leave" data-id="${e.id}">标记休假</button>
        </div>
        <div class="row">
          <label class="mini-l">岗位<select class="sel" data-act="role" data-id="${e.id}">${roleOpts}</select></label>
          <label class="mini-l">班组<select class="sel" data-act="group" data-id="${e.id}">${groupOpts(e.group)}</select></label>
        </div>
        <div class="row">
          <label class="mini-l">车站<select class="sel" data-act="sec" data-id="${e.id}">${secOpts}</select></label>
          <label class="mini-l">特殊时期<select class="sel" data-act="status" data-id="${e.id}">${statusOpts}</select></label>
          <label class="mini-l">工时制<select class="sel" data-act="hour" data-id="${e.id}">${hourOpts}</select></label>
        </div></div>`;
    }).join('') || '<div class="empty">无匹配人员</div>';
  }

  // ---- 告警中心 ----
  function renderAlerts(result){
    const area=document.getElementById('alertArea');
    if(!result){ area.innerHTML='<div class="empty">尚未生成</div>'; return; }
    const groups=[
      {type:'unstaffed',label:'🚫 排班缺口（无人可顶）',lv:'error'},
      {type:'swap',label:'🔁 换班冲突（顶岗人不可用）',lv:'error'},
      {type:'cert',label:'📄 资质缺口',lv:'warn'},
      {type:'overtime',label:'⏱ 工时超限',lv:'warn'},
      {type:'night',label:'🌙 孕期/哺乳期被安排夜班',lv:'warn'},
      {type:'rest',label:'🛏 强制休息标记（连续出勤超限）',lv:'warn'},
      {type:'crossgap',label:'🔀 跨站抽调缺口',lv:'warn'},
    ];
    let html='';
    groups.forEach(g=>{
      const items=result.warnings.filter(w=>w.type===g.type);
      html+=`<div class="al-group">
        <h3>${g.label}<span class="cnt">${items.length}</span></h3>`+
        (items.length? items.map(w=>`<div class="al-item ${g.lv}">${w.message}</div>`).join('')
                     : '<div class="empty" style="padding:8px">无</div>')+
        `</div>`;
    });
    area.innerHTML=html;
    document.getElementById('alertBadge').textContent=result.warnings.length;
  }

  // ---- 变动登记 ----
  function renderOverrides(){
    const box=document.getElementById('overrideList');
    const ids=Object.keys(overrides);
    if(!ids.length){ box.innerHTML='<div class="empty">暂无变动</div>'; return; }
    let html='';
    ids.forEach(eid=>{
      const e=byId(eid); if(!e)return;
      Object.keys(overrides[eid]).forEach(d=>{
        const ov=overrides[eid][d];
        const desc=ov.subBy ? `换班·${(byId(ov.subBy)||{}).name||'?'}顶岗` : ov.leave;
        html+=`<div class="ov-item"><span>${e.sectionName}·${e.name} — ${desc} — ${d.slice(5)}</span>
          <span class="x" data-del="${eid}" data-date="${d}">✕</span></div>`;
      });
    });
    box.innerHTML=html;
  }

  // ---- 导出 CSV（三种报表：意见9）----
  function exportCSV(){
    if(!lastResult){ toast('请先生成排班'); return; }
    const sch=lastResult.schedule;
    const rows=[];
    rows.push(['分组','班组','姓名','岗位','工号','性质','特殊时期',...curDates.map(d=>d.slice(5)+'周'+wdOf(d))].join(','));
    sections.forEach(sec=>{
      employees.filter(e=>e.sectionId===sec.id).forEach(e=>{
        const cells=curDates.map(d=>csvCell(sch[e.id][d].text));
        rows.push([sec.name,e.group||'',e.name,e.post,e.workno,e.type,e.status||'',...cells].map(csvCell).join(','));
      });
    });
    const csv='\uFEFF'+rows.join('\r\n');
    download(csv,'6号线排班_'+curDates[0]+'_'+curDates[curDates.length-1]+'.csv');
    toast('已导出排班班表 CSV（可直接用 Excel 打开）');
  }

  // 统计每人周期数据（夜班/工时/休假/换班）
  function periodStats(sch){
    return employees.map(e=>{
      let shifts=0,big=0,small=0,swaps=0,run=0,maxRun=0;
      const leaves={};
      curDates.forEach(d=>{
        const c=sch[e.id][d];
        if(c && c.code && !c.isRest){
          shifts++;
          const nk=window.Line6Engine.nightKind(c.code);
          if(nk==='大夜') big++; else if(nk==='小夜') small++;
        }
        if(c && c.swapBy) swaps++;
        if(c && c.leaveType){ leaves[c.leaveType]=(leaves[c.leaveType]||0)+1; }
        if(c && c.code && !c.isRest && !c.isAbsent){ run++; if(run>maxRun)maxRun=run; } else run=0;
      });
      const hours=shifts*window.Line6Engine.HOURS_PER_SHIFT;
      // 2.0意见3：折算月工时 = 周期出勤工时 ÷ 周期天数 × 折算月天数（参数见文件顶部）
      const monthHours=Math.round(hours/curDates.length*MONTH_CONVERT_DAYS*10)/10;
      const sys=e.hourSystem||'标准工时制';
      const gap=sys==='不定时工作制'?'—':Math.round((monthHours-STANDARD_MONTH_HOURS)*10)/10;
      const leavesStr=Object.keys(leaves).length
        ? Object.keys(leaves).map(k=>k+leaves[k]).join(' ') : '无';
      return {e,shifts,big,small,swaps,hours,monthHours,sys,gap,leavesStr,maxRun};
    });
  }

  // 意见9：月结果考勤报表
  function exportMonthlyResult(){
    if(!lastResult){ toast('请先生成排班'); return; }
    const sch=lastResult.schedule;
    const stats=periodStats(sch);
    const rows=[];
    rows.push(['分组','班组','姓名','岗位','工号','性质','工时制','出勤班数','大夜','小夜','周期出勤工时(h)','折算月工时(h)','月标准工时(h)','超缺工时(h)','连续出勤上限(天)','休假/未在岗明细'].join(','));
    sections.forEach(sec=>{
      employees.filter(e=>e.sectionId===sec.id).forEach(e=>{
        const st=stats.find(x=>x.e.id===e.id);
        rows.push([sec.name,e.group||'',e.name,e.post,e.workno,e.type,st.sys,
          st.shifts,st.big,st.small,st.hours,st.monthHours,
          st.sys==='不定时工作制'?'—':STANDARD_MONTH_HOURS, st.gap, st.maxRun,
          st.leavesStr].map(csvCell).join(','));
      });
    });
    const csv='\uFEFF'+rows.join('\r\n');
    download(csv,'6号线月结果考勤报表_'+curDates[0]+'_'+curDates[curDates.length-1]+'.csv');
    toast('已导出月结果考勤报表（含工时超缺与夜班认定）');
  }

  // 意见9：月考勤排班报表（全员×日期 班次矩阵）
  function exportMonthlyMatrix(){
    if(!lastResult){ toast('请先生成排班'); return; }
    const sch=lastResult.schedule;
    const rows=[];
    rows.push(['班组','分组','姓名','岗位','工号',...curDates.map(d=>d.slice(5)+'周'+wdOf(d))].join(','));
    sections.forEach(sec=>{
      employees.filter(e=>e.sectionId===sec.id).forEach(e=>{
        const cells=curDates.map(d=>{
          const c=sch[e.id][d];
          if(!c) return '休';
          if(c.isRest && !c.swapBy) return '休';
          return c.text||c.code||'休';
        });
        rows.push([e.group||'',sec.name,e.name,e.post,e.workno,...cells].map(csvCell).join(','));
      });
    });
    const csv='\uFEFF'+rows.join('\r\n');
    download(csv,'6号线月考勤排班报表_'+curDates[0]+'_'+curDates[curDates.length-1]+'.csv');
    toast('已导出月考勤排班报表（全员班次矩阵）');
  }
  function csvCell(s){ s=(s==null?'':String(s)); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
  function download(text,name){
    const blob=new Blob([text],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  // ---- 交互 ----
  function bindEvents(){
    document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>switchTab(t.dataset.tab));
    document.getElementById('btnGenerate').onclick=()=>doGenerate(false);
    document.getElementById('btnExport').onclick=exportCSV;
    document.getElementById('btnReset').onclick=()=>{
      if(!confirm('确定重置为示例数据？已登记的变动将清空。'))return;
      employees=clone(SEED.employees); sections=clone(SEED.sections);
      for(const k in overrides)delete overrides[k];
      structuralChanged=false; lastResult=null; lastGenSig=null;
      buildSectionFilter(); buildChangeForm(); doGenerate(true); toast('已重置为示例数据');
    };
    document.getElementById('sectionFilter').onchange=()=>renderSchedule(lastResult.schedule);
    document.getElementById('onlyChanged').onchange=()=>renderSchedule(lastResult.schedule);
    document.getElementById('schedSearch').oninput=()=>renderSchedule(lastResult.schedule);
    document.getElementById('statusFilter').onchange=()=>renderSchedule(lastResult.schedule);

    // 导出菜单（意见9：三种报表）
    const exBtn=document.getElementById('btnExport'), exMenu=document.getElementById('exportMenu');
    exBtn.onclick=(ev)=>{ ev.stopPropagation(); exMenu.style.display=exMenu.style.display==='none'?'flex':'none'; };
    document.addEventListener('click',()=>{ exMenu.style.display='none'; });
    exMenu.onclick=(ev)=>{
      const b=ev.target.closest('button[data-exp]'); if(!b)return;
      exMenu.style.display='none';
      if(b.dataset.exp==='shift') exportCSV();
      else if(b.dataset.exp==='result') exportMonthlyResult();
      else exportMonthlyMatrix();
    };

    // 周期延续
    function resetExtension(){
      ext.active=false; curDates=DATES.slice();
      buildChangeForm(); updatePeriodLabel();
      document.getElementById('extInfo').textContent='';
      lastResult=null; doGenerate(true);
    }
    function toggleExtension(){
      switchTab('schedule');
      const bar=document.getElementById('extBar');
      const willShow = bar.style.display==='none';
      bar.style.display = willShow ? 'flex' : 'none';
      if(!willShow) resetExtension();
    }
    const t1=document.getElementById('btnExtToggle'); if(t1) t1.onclick=toggleExtension;
    const t2=document.getElementById('btnExtToggleTop'); if(t2) t2.onclick=toggleExtension;
    document.getElementById('btnExtend').onclick=()=>{
      ext.active=true; ext.weeks=Math.max(1, parseInt(document.getElementById('extWeeks').value)||1);
      ext.keep=document.getElementById('extKeep').checked;
      const nd=computeNewDates(ext.weeks);
      curDates=DATES.concat(nd);
      buildChangeForm(); updatePeriodLabel();
      lastResult=null;            // 强制重新生成（日期范围已变）
      doGenerate(false);
      document.getElementById('extInfo').textContent=
        `已延续至 ${nd[nd.length-1]}，共 ${curDates.length} 天；${ext.keep?'已复用原周期休假/顶替标注':'仅复用班次旋转（新周期从干净轮班开始）'}`;
    };
    document.getElementById('btnExtReset').onclick=resetExtension;

    document.getElementById('peopleType').onchange=renderPeople;
    document.getElementById('peopleRole').onchange=renderPeople;
    document.getElementById('peopleSearch').oninput=renderPeople;

    document.getElementById('btnAddLeave').onclick=()=>{
      const eid=document.getElementById('chgPerson').value;
      const lv=document.getElementById('chgLeave').value;
      const ds=[...document.querySelectorAll('#chgDates input:checked')].map(c=>c.value);
      if(!ds.length){ toast('请至少选择一个日期'); return; }
      overrides[eid]=overrides[eid]||{};
      ds.forEach(d=>overrides[eid][d]={leave:lv});
      renderOverrides(); toast(`已登记：${byId(eid).name} ${lv} ×${ds.length}天，点「生成」生效`);
    };
    // 意见1：换班/顶岗登记
    document.getElementById('btnAddSwap').onclick=()=>{
      const aid=document.getElementById('chgSwapPerson').value;
      const bid=document.getElementById('chgSwapBy').value;
      if(aid===bid){ toast('被顶岗人与顶岗人不能是同一人'); return; }
      const ds=[...document.querySelectorAll('#swapDates input:checked')].map(c=>c.value);
      if(!ds.length){ toast('请至少选择一个日期'); return; }
      overrides[aid]=overrides[aid]||{};
      ds.forEach(d=>overrides[aid][d]={subBy:bid});
      renderOverrides();
      toast(`已登记换班：${byId(bid).name} 顶 ${byId(aid).name} ×${ds.length}天，点「生成」生效`);
    };
    document.getElementById('overrideList').onclick=(ev)=>{
      const x=ev.target.closest('.x'); if(!x)return;
      const eid=x.dataset.del, d=x.dataset.date;
      delete overrides[eid][d]; if(!Object.keys(overrides[eid]).length)delete overrides[eid];
      renderOverrides(); toast('已移除该变动');
    };

    // 人员卡片操作（事件委托）
    document.getElementById('peopleArea').onclick=(ev)=>{
      const b=ev.target.closest('button[data-act]'); if(!b)return;
      const id=b.dataset.id, act=b.dataset.act, e=byId(id);
      if(act==='toggle'){
        e.type = e.type==='备班'?'普通':'备班'; structuralChanged=true;
        renderPeople(); renderTopStats(lastResult); toast(`${e.name} → ${e.type}`);
      } else if(act==='leave'){
        document.getElementById('chgPerson').value=id;
        switchTab('changes'); toast('已选中，请在右侧选择休假类型与日期');
      }
    };
    document.getElementById('peopleArea').onchange=(ev)=>{
      const s=ev.target.closest('select[data-act]'); if(!s)return;
      const e=byId(s.dataset.id); if(!e)return;
      const act=s.dataset.act;
      if(act==='sec'){ e.sectionId=s.value; structuralChanged=true;
        renderPeople(); toast(`${e.name} 所属站改为 ${secName(s.value)}`); }
      else if(act==='role'){ e.role=s.value; structuralChanged=true;   // 意见2：岗位变动入口
        renderPeople(); renderSchedule(lastResult.schedule);
        toast(`${e.name} 岗位改为 ${s.value}（建议点「生成」重排）`); }
      else if(act==='group'){   // 意见7：班组变动入口
        if(s.value==='__new__'){
          const g=prompt('输入新班组名称（如：四班1）：');
          if(!g){ renderPeople(); return; }
          e.group=g.trim();
        } else e.group=s.value||'';
        renderPeople(); renderSchedule(lastResult.schedule);
        toast(e.group?`${e.name} 班组改为 ${e.group}`:`${e.name} 已设为未分组`);
      }
      else if(act==='status'){ e.status=s.value||'';   // 意见11：孕期/哺乳期
        renderPeople(); toast(s.value?`${e.name} 已标记${s.value}（不宜夜班）`:`${e.name} 已取消特殊时期标记`); }
      else if(act==='hour'){ e.hourSystem=s.value;     // 意见3：劳动合同工时制
        renderPeople(); toast(`${e.name} 工时制改为 ${s.value}`); }
    };
    // 2.0意见2：按角色一键设置工时制
    document.getElementById('btnBulkHour').onclick=()=>{
      const role=document.getElementById('bulkHourRole').value;
      const sys=document.getElementById('bulkHourSystem').value;
      const targets=employees.filter(e=>!role||e.role===role);
      if(!targets.length){ toast('没有匹配的人员'); return; }
      if(!confirm(`将 ${role||'全部'} 角色共 ${targets.length} 人 的工时制统一设为「${sys}」？`)) return;
      targets.forEach(e=>e.hourSystem=sys);
      structuralChanged=true;
      renderPeople();
      toast(`已设置 ${role||'全部角色'} ${targets.length} 人为「${sys}」`);
    };
  }
  function switchTab(name){
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+name));
    if(name==='people') renderPeople();
    if(name==='changes') renderOverrides();
  }

  // ---- toast ----
  let toastTimer;
  function toast(msg){
    const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  } // end boot(SEED)

  if (window.LINE6_SEED) boot(window.LINE6_SEED);
  else if (window.LINE6_SEED_PROMISE) window.LINE6_SEED_PROMISE.then(boot);
  else console.error('未找到排班数据（seedc.js 未加载？）');
})();
