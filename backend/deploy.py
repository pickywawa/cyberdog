"""Deploy the cloud gateway (operator only; needs SUPABASE_TOKEN, never bundled with the app)."""
import os,json,urllib.request,urllib.error,pathlib,secrets
from management import PROJECT_REF
boundary='----cyberdog'+secrets.token_hex(12);parts=[]
def part(name,value,filename=None):
    header='--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"'+('; filename="'+filename+'"' if filename else '')+'\r\nContent-Type: '+('application/javascript' if filename else 'application/json')+'\r\n\r\n'
    parts.append(header.encode()+value+b'\r\n')
part('metadata',json.dumps({'name':'cyberdog-cloud','entrypoint_path':'cloud-index.ts','verify_jwt':False}).encode())
for filename in ['cloud-index.ts','cloud-handler.js']:
    part('file',(pathlib.Path(__file__).parent/'functions'/filename).read_bytes(),filename)
body=b''.join(parts)+('--'+boundary+'--\r\n').encode()
req=urllib.request.Request('https://api.supabase.com/v1/projects/'+PROJECT_REF+'/functions/deploy?slug=cyberdog-cloud',method='POST',data=body,headers={'Authorization':'Bearer '+os.environ['SUPABASE_TOKEN'],'Content-Type':'multipart/form-data; boundary='+boundary})
try:
    with urllib.request.urlopen(req,timeout=90) as r:result=json.load(r)
    print(json.dumps({k:result.get(k) for k in ['slug','status','version','verify_jwt']}))
except urllib.error.HTTPError as e:
    print(e.code,e.read().decode());raise SystemExit(1)
