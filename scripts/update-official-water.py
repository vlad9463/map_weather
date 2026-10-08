#!/usr/bin/env python3
"""Fetch dated, official Samara Volga water levels from the Volga Basin Administration.
Only real readings directly parsed from the downloadable daily XLS are saved.
"""
import concurrent.futures
import datetime as dt
import json
import pathlib
import re
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo
import xlrd

ROOT=pathlib.Path(__file__).resolve().parent.parent
HISTORY=ROOT/'data/volga-level-history.json'
SUMMARY=ROOT/'data/volga-samara.json'
BASE='https://xn--80adbch2buek4ak3i.xn--p1ai'
INDEX=BASE+'/navigatsiya/operativnaya_informatsiya_o_sudohodnyih_usloviyah/'
STATION_KM=1737
SOURCE='ФБУ «Администрация Волжского бассейна» · ежедневный бюллетень'
TZ=ZoneInfo('Europe/Samara')
TODAY=dt.datetime.now(TZ).date()
NOW=dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')

def request(url):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; RybTochki/1.0)','Accept':'*/*'})
    with urllib.request.urlopen(req,timeout=22) as resp:
        if resp.status!=200:raise ValueError('HTTP '+str(resp.status))
        return resp.read(3_000_000)

def daily_url(day):
    return BASE+'/uploads/'+day.strftime('%d.%m.%Y')+'.xls'

def latest_bulletin_date():
    page=request(INDEX).decode('utf-8',errors='replace')
    dates=[]
    for day,month,year in re.findall(r'(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[0-2])\.(20[0-9]{2})\.xls',page):
        try:
            d=dt.date(int(year),int(month),int(day))
        except ValueError:
            continue
        if d<=TODAY:dates.append(d)
    return max(dates) if dates else None

def parse_bulletin(raw,day):
    if not raw.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        raise ValueError('Not an Excel XLS/OLE file')
    wb=xlrd.open_workbook(file_contents=raw,on_demand=True)
    ws=next((s for s in wb.sheets() if s.name.lower().strip()=='уровни воды'),None)
    if ws is None:raise ValueError('Sheet "уровни воды" absent')
    records=[]
    for row in range(ws.nrows):
        cells=ws.row_values(row)
        if len(cells)<5:continue
        try:
            km=float(cells[0])
            name=str(cells[1]).strip().lower()
        except (TypeError,ValueError,IndexError):
            continue
        if abs(km-STATION_KM)>.01 or name!='самара':continue
        try:
            level=float(str(cells[3]).strip().replace(',','.'))
        except ValueError:raise ValueError('Missing numeric water level for Samara')
        if not 20<=level<=40:raise ValueError('Water level outside allowed Samara range')
        records.append(level)
    if len(records)!=1:raise ValueError('Expected exactly one Volga Samara 1737 km row, got '+str(len(records)))
    return {'date':day.isoformat(),'value':round(records[0],2),'unit':'м БС',
        'sourceName':SOURCE,'sourceUrl':daily_url(day),
        'provenance':'automated_source','kind':'hydropost','retrievedAt':NOW}

def fetch_day(day):
    try:
        return parse_bulletin(request(daily_url(day)),day),None
    except Exception as error:
        return None,f'{day.isoformat()}: {type(error).__name__}: {error}'

def read_json(path,default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError,ValueError):
        return default

def main():
    history=read_json(HISTORY,{'station':'Волга у Самары','unit':'м БС','observations':[]})
    previous=[v for v in history.get('observations',[]) if
        v.get('provenance')=='automated_source' and
        isinstance(v.get('value'),(int,float)) and
        isinstance(v.get('date'),str) and
        re.fullmatch(r'\d{4}-\d{2}-\d{2}',v['date']) and v.get('sourceUrl')]
    entries={r['date']:r for r in previous}
    errors=[]
    try:
        latest=latest_bulletin_date()
    except Exception as error:
        latest=None
        errors.append('Не удалось получить список официальных бюллетеней: '+str(error))
    if not latest:
        # Filename convention is verified; still require actual valid XLS+station.
        latest=TODAY
    if (TODAY-latest).days>7:
        errors.append(f'Последний опубликованный бюллетень старый: {latest}')
    days=31 if len(entries)<8 else 8
    candidates=[latest-dt.timedelta(days=i) for i in range(days)]
    candidates=[d for d in candidates if d>dt.date(2020,1,1) and
                (d.isoformat() not in entries or (latest-d).days<=2)]
    # Moderate concurrency avoids excessive load on the official service.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for observation,error in pool.map(fetch_day,candidates):
            if observation:
                entries[observation['date']]=observation
            elif error:
                errors.append(error)
    history['station']='Волга у Самары'
    history['unit']='м БС'
    history['note']='Только наблюдения, автоматически прочитанные из официальных ежедневных XLS. Пропущенные дни не заполняются.'
    history['observations']=[entries[k] for k in sorted(entries)][-365:]
    HISTORY.write_text(json.dumps(history,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    summary=read_json(SUMMARY,{})
    summary['station']='Волга у Самары / Самарская область'
    summary['updatedAt']=NOW
    summary.setdefault('errors',{})
    if history['observations']:
        record=history['observations'][-1]
        obs_date=dt.date.fromisoformat(record['date'])
        delta=(TODAY-obs_date).days
        summary['level']={
          'value':record['value'],'unit':'м БС','observedOn':record['date'],
          'kind':'hydropost','provenance':'automated_source',
          'sourceName':SOURCE,'sourceUrl':record['sourceUrl'],
          'retrievedAt':record['retrievedAt'],
          'status':'ok' if 0<=delta<=2 else 'stale'
        }
        if delta>2:summary['level']['warning']='Последняя измеренная отметка устарела'
        if delta>2:summary['errors']['level']=f'Нет нового уровня: последние наблюдения за {record["date"]}'
        else:summary['errors'].pop('level',None)
    else:
        summary['level']=None
        summary['errors']['level']='Нет датированных измерений из официального XLS'
    if errors:
        summary['errors']['level_import']='; '.join(errors[:5])
    else:
        summary['errors'].pop('level_import',None)
    SUMMARY.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'checkedAt':NOW,'latestPublished':latest.isoformat(),
        'daysRequested':len(candidates),'historyCount':len(history['observations']),
        'latestObservation':summary['level'],'failures':errors[:5]},ensure_ascii=False,indent=2))

if __name__=='__main__':
    main()
