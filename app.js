/* 厦门地铁6号线 智能排班 - 前端逻辑 */
(function () {
  'use strict';
  function boot(SEED) {
  const DATES = SEED.meta.dates;           // 模板周期（原 Excel 的 8 天）
  const WD = ['日','一','二','三','四','五','六'];
  function wdOf(date){ const d=new Date(date+'T00:00:00'); return WD[d.getDay()]; }

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
    return JSON.stringify([employees.map(e=>[e.id,e.type,e.sectionId]), overrides]);
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
    const dc=document.getElementById('chgDates');
    dc.className='dates';
    dc.innerHTML=curDates.map(d=>`<label><input type="checkbox" value="${d}">${d.slice(5)}<small>周${wdOf(d)}</small></label>`).join('');
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

  // ---- 排班总表 ----
  function renderSchedule(schedule){
    const area=document.getElementById('scheduleArea');
    const onlyCh=document.getElementById('onlyChanged').checked;
    const secFilter=document.getElementById('sectionFilter').value;
    const q=(document.getElementById('schedSearch').value||'').trim();

    const emps = employees.filter(e=>{
      if(secFilter && e.sectionId!==secFilter) return false;
      if(q && !(e.name.includes(q)||e.workno.includes(q))) return false;
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
          const cells=curDates.map(d=>{
            const c=schedule[e.id][d];
            const cls=cellClass(c)+( (onlyCh && !c.sameAsBase)?' changed':'');
            const mini = c.leaveType?`<span class="mini">${c.leaveType}</span>`:(c.dispatchedTo?`<span class="mini">${c.dispatchedTo}</span>`:'');
            return `<td class="cell ${cls}">${c.text||''}${mini}</td>`;
          }).join('');
          return `<tr><td class="name">${e.name}<span class="role-tag rt-${rc}">${e.role}</span>
              <div class="mini" style="color:#9aa6b2">${e.post}</div></td>${cells}</tr>`;
        }).join('')+
        `</tbody></table></div>`;
    });
    area.innerHTML = html || '<div class="empty">无匹配人员</div>';
  }
  function cellClass(c){
    if(c.isWarning) return 'warn';
    if(c.isSubstitute) return 'sub';
    if(c.isAbsent) return 'leave';
    if(c.isRest) return 'rest';
    return 'normal';
  }
  function roleClass(r){ return r==='站务员'?'站务员':r==='行值'?'行值':r==='值站'?'值站':'管理'; }

  // ---- 人员管理 ----
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
    area.innerHTML=list.map(e=>{
      const certs=SEED.meta.certTypes.map(ct=>{
        const on=e.certs[ct]; return `<span class="cert ${on?'on':''}">${ct}${on?'✓':''}</span>`;
      }).join('');
      const secOpts=sections.map(s=>`<option value="${s.id}" ${s.id===e.sectionId?'selected':''}>${s.name}</option>`).join('');
      return `<div class="pcard ${e.type==='备班'?'is-reserve':''}">
        <h4>${e.name}<span class="role-tag rt-${roleClass(e.role)}">${e.role}</span>
          ${e.type==='备班'?'<span class="role-tag" style="background:#fff3e0;color:#e65100">备班</span>':''}</h4>
        <div class="meta">${secName(e.sectionId)} · ${e.post} · 工号 ${e.workno}</div>
        <div class="certs">${certs}</div>
        <div class="row">
          <button class="toggle ${e.type==='备班'?'reserve':''}" data-act="toggle" data-id="${e.id}">
            ${e.type==='备班'?'恢复正岗':'设为备班'}</button>
          <select class="sel" data-act="sec" data-id="${e.id}">${secOpts}</select>
          <button class="toggle" data-act="leave" data-id="${e.id}">标记休假</button>
        </div></div>`;
    }).join('') || '<div class="empty">无匹配人员</div>';
  }

  // ---- 告警中心 ----
  function renderAlerts(result){
    const area=document.getElementById('alertArea');
    if(!result){ area.innerHTML='<div class="empty">尚未生成</div>'; return; }
    const groups=[
      {type:'unstaffed',label:'🚫 排班缺口（无人可顶）',lv:'error'},
      {type:'cert',label:'📄 资质缺口',lv:'warn'},
      {type:'overtime',label:'⏱ 工时超限',lv:'warn'},
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
        const lv=overrides[eid][d].leave;
        html+=`<div class="ov-item"><span>${e.sectionName}·${e.name} — ${lv} — ${d.slice(5)}</span>
          <span class="x" data-del="${eid}" data-date="${d}">✕</span></div>`;
      });
    });
    box.innerHTML=html;
  }

  // ---- 导出 CSV ----
  function exportCSV(){
    if(!lastResult){ toast('请先生成排班'); return; }
    const sch=lastResult.schedule;
    const rows=[];
    rows.push(['分组','姓名','岗位','工号','性质',...curDates.map(d=>d.slice(5)+'周'+wdOf(d))].join(','));
    sections.forEach(sec=>{
      employees.filter(e=>e.sectionId===sec.id).forEach(e=>{
        const cells=curDates.map(d=>csvCell(sch[e.id][d].text));
        rows.push([sec.name,e.name,e.post,e.workno,e.type,...cells].map(csvCell).join(','));
      });
    });
    const csv='\uFEFF'+rows.join('\r\n');
    download(csv,'6号线排班_'+curDates[0]+'_'+curDates[curDates.length-1]+'.csv');
    toast('已导出 CSV（可直接用 Excel 打开）');
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
      const s=ev.target.closest('select[data-act="sec"]'); if(!s)return;
      const e=byId(s.dataset.id); e.sectionId=s.value; structuralChanged=true;
      renderPeople(); toast(`${e.name} 所属站改为 ${secName(s.value)}`);
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
