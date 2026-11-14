"""Configure Supabase Auth for Cyberdog (operator only; needs SUPABASE_TOKEN).

E-mail addresses are verified with a 6-digit code (sign-up) and every new sign-in needs a second e-mail code
(enforced by the cyberdog-cloud gateway). A custom SMTP server must already be configured on the project.
Deploy migration 010 and the gateway BEFORE running this, otherwise sign-ups pause until they are live.
"""
from management import api

def mail(title, intro):
    return ('<h2>' + title + '</h2><p>' + intro + '</p>'
            '<p style="font-size:28px;letter-spacing:6px"><b>{{ .Token }}</b></p>'
            '<p>This code expires in 10 minutes. If you did not request it, ignore this e-mail and do not share the code.</p>')

api('PATCH', '/config/auth', {
    'disable_signup': False,
    'external_email_enabled': True,
    'mailer_autoconfirm': False,            # sign-ups must prove mailbox ownership
    'password_min_length': 8,
    'mailer_otp_length': 6,
    'mailer_otp_exp': 600,
    'site_url': 'https://pickywawa.github.io/cyberdog',
    'mailer_subjects_confirmation': 'Cyberdog: your verification code',
    'mailer_templates_confirmation_content': mail('Confirm your Cyberdog account', 'Enter this code in Cyberdog to verify your e-mail address:'),
    'mailer_subjects_magic_link': 'Cyberdog: your sign-in code',
    'mailer_templates_magic_link_content': mail('Cyberdog sign-in', 'Enter this code in Cyberdog to finish signing in:'),
})
config = api('GET', '/config/auth')
print({k: config.get(k) for k in ['disable_signup', 'external_email_enabled', 'mailer_autoconfirm', 'password_min_length', 'mailer_otp_length', 'mailer_otp_exp', 'smtp_host']})
assert config.get('mailer_autoconfirm') is False, 'e-mail confirmation is still disabled'
assert config.get('smtp_host'), 'configure a custom SMTP server before enabling e-mail codes'
