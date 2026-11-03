"""Verify deployed boundaries. Fixtures run in rolled-back transactions; no emails are sent and no accounts are created."""
import json,urllib.request,urllib.error
from pathlib import Path
from management import api,PROJECT_REF
for name in ['account','workspace','assets-history','bastion','server-preferences','server-credentials']:
    api('POST','/database/query',{'query':(Path(__file__).parent/(name+'-security-test.sql')).read_text()})
keys=api('GET','/api-keys');anon=next(x['api_key'] for x in keys if x['name']=='anon')
base='https://'+PROJECT_REF+'.supabase.co'
for route,body,headers in [
 ('/rest/v1/rpc/cyberdog_account',{'action':'list'},{}),
 ('/rest/v1/rpc/cyberdog_member_action',{'identity_id':'00000000-0000-4000-8000-000000000001','action':'list'},{}),
 ('/rest/v1/rpc/cyberdog_bind_auth',{'auth_id':'00000000-0000-4000-8000-000000000001','email':'forged@example.invalid'},{}),
 ('/rest/v1/rpc/cyberdog_invite_link_accept',{'uid':'00000000-0000-4000-8000-000000000001','hash':'a'*64},{}),
 ('/functions/v1/cyberdog-cloud',{'userId':'victim','action':'list'},{}),
 ('/functions/v1/cyberdog-cloud',{'action':'list'},{'Authorization':'Bearer forged.token.value'}),
]:
    req=urllib.request.Request(base+route,method='POST',data=json.dumps(body).encode(),headers={'apikey':anon,'Authorization':'Bearer '+anon,'Content-Type':'application/json',**headers})
    try:
        with urllib.request.urlopen(req,timeout=40) as r:status=r.status;r.read()
    except urllib.error.HTTPError as e:status=e.code;e.read()
    assert status in (400,401,403,404),(route,status)
print('Live checks passed: team scopes, same-email isolation, invitation links, permissions, blocked client RPCs and forged gateway requests. Fixtures rolled back.')
