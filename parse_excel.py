#!/usr/bin/env python
# 把厦门地铁6号线人工排班 Excel 解析为结构化 JSON，供前端加载。
import openpyxl, re, json, datetime
from collections import Counter, defaultdict

PATH = r"C:/Users/86152/Desktop/新建 XLSX 工作表.xlsx"
OUT   = r"C:/Users/86152/WorkBuddy/2026-11-04-15-16-54/line6-scheduler/seed.json"

KNOWN_SHIFTS = {"R1","KA1-1","KB1","KA2-1","KA7-1","KB2-1"}
CERT_COLS = [("上岗证","上岗证"),("国考消防证","消防证"),("电梯证","电梯证"),("施工负责人证","施工负责人证")]
LEAVE_WORDS = ["年假","病假","育儿假","婚假","产假","事假","工伤假","陪产","探亲假"]

wb = openpyxl.load_workbook(PATH, data_only=True)
ws = wb['Sheet1']

# 定位分区头行
header_rows=[r for r in range(1,ws.max_row+1)
             if ws.cell(r,1).value=='序号' and ws.cell(r,4).value=='姓名']
# 日期列
def to_date(v): return isinstance(v, datetime.datetime)
date_cols=[]
for c in range(11, ws.max_column+1):
    v=ws.cell(header_rows[0],c).value
    if to_date(v):
        date_cols.append((c, v.strftime('%Y-%m-%d'),
                          ['日','一','二','三','四','五','六'][v.weekday()]))
DATES=[d[1] for d in date_cols]

def role_of(post):
    p=post or ""
    if '值班站长' in p: return '值站'
    if '行车值班员' in p: return '行值'
    if '站务员' in p: return '站务员'
    if any(k in p for k in ['管理','主任','副主任']): return '管理'
    return '其他'

def parse_cell(s):
    """返回 {code, leaveType, substitute, dispatchedTo, replace, annotation}"""
    if s is None: return dict(code=None,leaveType=None,substitute=None,
                              dispatchedTo=None,replace=None,annotation=None)
    s=str(s).strip()
    # 提取前导班次代号
    m=re.match(r'^([A-Za-z0-9\-]+)', s)
    code=None
    if m:
        cand=m.group(1)
        code=cand if cand in KNOWN_SHIFTS else (cand if re.fullmatch(r'[A-Za-z0-9\-]+',cand) else None)
    inner=None
    pm=re.search(r'[（(]([^（）()]*)[）)]', s)
    if pm: inner=pm.group(1).strip()
    res=dict(code=code,leaveType=None,substitute=None,dispatchedTo=None,
             replace=None,annotation=None)
    if inner is None:
        if code is None:
            res['annotation']=s
        return res
    # 含“替”
    if '替' in inner:
        if '，' in inner or ',' in inner:
            a,b=[x.strip() for x in re.split(r'[，,]', inner,1)]
            # a 可能是 假种 或 站名; b 形如 "X替"
            sub=re.sub(r'替$','',b).strip()
            if any(w in a for w in LEAVE_WORDS):
                res['leaveType']=a; res['substitute']=sub
            else:
                # 顶替人视角：站名，替Y
                res['dispatchedTo']=a; res['replace']=sub
        else:
            # 仅为 "X替" —— 本人空缺被X顶
            res['substitute']=re.sub(r'替$','',inner).strip()
        return res
    if any(w in inner for w in LEAVE_WORDS):
        res['leaveType']=inner; return res
    # 其他标注：培训/跟岗/换班/站名
    res['annotation']=inner
    return res

# 收集分区
sections=[]   # {id,name,kind}
emp_rows=[]   # 中间行
sec_id_map={}
for i,hr0 in enumerate(header_rows):
    hr1=header_rows[i+1] if i+1<len(header_rows) else ws.max_row+1
    # 判断分区类型：看该区前几人的岗位
    posts_here=[]
    for r in range(hr0+2, hr1):
        p=ws.cell(r,5).value
        if p: posts_here.append(p)
    name=None
    # section name：取该区第一个有车站值的人；管理区为空
    for r in range(hr0+2, hr1):
        sv=ws.cell(r,2).value
        if sv: name=sv; break
    if name is None: name='管理'
    if name=='备班': kind='备班'
    elif name=='参建人员': kind='参建'
    elif any(role_of(p)=='管理' for p in posts_here) and all(role_of(p) in ('管理','其他') for p in posts_here):
        kind='管理'
    else: kind='车站'
    sid=f"sec{i}"
    sec_id_map[hr0]=sid
    sections.append({'id':sid,'name':name,'kind':kind})
    for r in range(hr0+2, hr1):
        nm=ws.cell(r,4).value
        if not nm: continue
        emp_rows.append((sid,name,r))

employees=[]
for sid,secname,r in emp_rows:
    nm=ws.cell(r,4).value
    if not nm: continue
    post=ws.cell(r,5).value or ""
    workno=ws.cell(r,6).value
    certs={}
    for idx,(col,key) in enumerate(CERT_COLS, start=7):
        v=ws.cell(r,idx).value
        certs[key]= (str(v).strip()=='是') if v is not None else False
    role=role_of(post)
    is_reserve = (secname=='备班')
    base={}
    weekday_shift=defaultdict(Counter)  # 仅用于推断应排班次
    for (c,ds,wd) in date_cols:
        raw=ws.cell(r,c).value
        parsed=parse_cell(raw)
        # 推断应排班次：若本人当天有班次代号即用；否则记休息
        intended = parsed['code']
        if parsed['leaveType'] and not parsed['code']:
            # 休假但没写班次：留空，生成时按 weekday 推断
            intended=None
        if intended:
            weekday_shift[wd][intended]+=1
        base[ds]={
            'raw': ('' if raw is None else str(raw)),
            'code': parsed['code'],
            'leaveType': parsed['leaveType'],
            'substitute': parsed['substitute'],
            'dispatchedTo': parsed['dispatchedTo'],
            'replace': parsed['replace'],
            'annotation': parsed['annotation'],
            'intended': intended,
            'isRest': raw is None,
        }
    # 为休息/无班次日推断应排班次（取该 weekday 最常见班次）
    wd_default={wd:cnt.most_common(1)[0][0] for wd,cnt in weekday_shift.items() if cnt}
    for ds,cell in base.items():
        if cell['intended'] is None and not cell['isRest']:
            # 有病假/年假但无班次：用 weekday 默认
            wd=['日','一','二','三','四','五','六'][datetime.date(*map(int,ds.split('-'))).weekday()]
            cell['intended']=wd_default.get(wd)
    employees.append({
        'id': f"e{len(employees)+1}",
        'no': ws.cell(r,1).value,
        'sectionId': sid,
        'sectionName': secname,
        'name': nm,
        'post': post,
        'role': role,
        'workno': ('' if workno is None else str(workno)),
        'type': '备班' if is_reserve else '普通',
        'certs': certs,
        'base': base,
    })

data={
    'meta':{
        'line':'厦门地铁6号线',
        'startDate':DATES[0],'endDate':DATES[-1],'dates':DATES,
        'shiftCodes':sorted(KNOWN_SHIFTS),
        'certTypes':[k for _,k in CERT_COLS],
        'generatedAt':datetime.datetime.now().isoformat(timespec='seconds'),
    },
    'sections':sections,
    'employees':employees,
}
import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT,'w',encoding='utf-8') as f:
    json.dump(data,f,ensure_ascii=False,indent=1)

# 统计报告
print("分区数:",len(sections))
print("人员数:",len(employees))
print("日期:",data['meta']['dates'])
print("角色分布:",dict(Counter(e['role'] for e in employees)))
print("性质分布:",dict(Counter(e['type'] for e in employees)))
print("资质分布:",{k:sum(1 for e in employees if e['certs'][k]) for k in data['meta']['certTypes']})
# 含顶替/休假的单元格数
sub_n=sum(1 for e in employees for d,c in e['base'].items() if c['substitute'])
disp_n=sum(1 for e in employees for d,c in e['base'].items() if c['dispatchedTo'])
leave_n=sum(1 for e in employees for d,c in e['base'].items() if c['leaveType'])
print(f"被顶替(本人行)人次:{sub_n}  派出去(备班行)人次:{disp_n}  休假标注:{leave_n}")
print("写入:",OUT)
