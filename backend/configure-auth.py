"""Enable email + password sign-up (operator only; needs SUPABASE_TOKEN)."""
from management import api
api('PATCH','/config/auth',{'disable_signup':False,'external_email_enabled':True,'mailer_autoconfirm':True,'password_min_length':8,'site_url':'https://pickywawa.github.io/cyberdog'})
config=api('GET','/config/auth')
print({k:config.get(k) for k in ['disable_signup','external_email_enabled','mailer_autoconfirm','password_min_length']})
