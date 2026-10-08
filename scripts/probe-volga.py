import json, urllib.request, urllib.error, pathlib, datetime, traceback
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
sources={
  "official_bulletin":"https://xn--80adbch2buek4ak3i.xn--p1ai/uploads/08.10.2026.xls",
  "official_info_page":"https://xn--80adbch2buek4ak3i.xn--p1ai/navigatsiya/operativnaya_informatsiya_o_sudohodnyih_usloviyah/",
  "bugorok_levels":"https://www.snt-bugorok.ru/category/01-urovni-vody-v-volge/",
  "ris_water":"https://volga.risweb.ru/water-levels.php"
}
def fetch(item):
 key,url=item
 try:
  req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 (RybTochki/1.0)","Accept":"*/*"})
  with urllib.request.urlopen(req,timeout=17) as f:
   data=f.read(2200000)
   info={"http":f.status,"size":len(data),"content_type":f.headers.get("content-type"),"magic":data[:12].hex()}
   if key=="official_bulletin" and len(data)>2000 and data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
    try:
     import xlrd
     book=xlrd.open_workbook(file_contents=data)
     sheets=[]
     for sheet in book.sheets():
      matches=[]
      for i in range(sheet.nrows):
       cells=[str(c).strip() for c in sheet.row_values(i)]
       if "самар" in " ".join(cells).lower():
        matches.append({"row":i+1,"data":cells[:24]})
       if len(matches)>=10:break
      sheets.append({"name":sheet.name,"rows":sheet.nrows,"cols":sheet.ncols,"matches":matches})
     info["sheets"]=sheets
    except Exception as error:info["excel_error"]=str(error)
   else:
    text=data.decode("utf-8",errors="replace")
    info["keywords"]={k:(k.lower() in text.lower()) for k in ["Самара","08.10.2026","Sorry, your request has been denied","Нет связи с сетью"]}
    info["head"]=text[:90]
   return key,info
 except Exception as error:return key,{"error":type(error).__name__+": "+str(error)[:200]}
if __name__=="__main__":
 result={"checkedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"sources":{}}
 with ThreadPoolExecutor(max_workers=4) as executor:
  for future in as_completed([executor.submit(fetch,item) for item in sources.items()]):
   key,val=future.result();result["sources"][key]=val
 pathlib.Path("data").mkdir(exist_ok=True)
 pathlib.Path("data/volga-source-probe.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
 print(json.dumps(result,ensure_ascii=False,indent=2))
