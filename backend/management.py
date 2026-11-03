"""Operator-only tooling. Never bundled with the desktop application."""
import os,json,urllib.request
PROJECT_REF='meqzncrinjifpjqjzwzf'
def api(method,endpoint,data=None):
    req=urllib.request.Request('https://api.supabase.com/v1/projects/'+PROJECT_REF+endpoint,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+os.environ['SUPABASE_TOKEN'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=90) as response:
        raw=response.read()
        return json.loads(raw) if raw else None
