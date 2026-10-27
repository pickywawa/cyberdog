let premiumState=null
let accountState={premium:false,teams:[],servers:[],assets:[],invitations:[]}
const premiumViews=new Set()
function updatePremium(state){premiumState=state}
function updateAccount(state){accountState=state}
function openPremiumDialog(){toast(t('premium.community'))}
function sharedLocationField(){return null}
function sharedScopeName(){return ''}
function sharedVisible(){return true}
function showServerHistory(){}
function editVaultServer(){}
function appendExtensionServers(){}
async function beforeActionRun(){return true}
function actionPayload(action){return action.script}
function buildVaultSettings(){return h('div',{className:'premium-placeholder'},h('span',{className:'premium-emblem',innerHTML:icon('star')}),h('h3',{textContent:t('settings.vaults')}),h('p',{className:'dim',textContent:t('premium.community')}))}
$('#btn-premium').onclick=()=>openPremiumDialog()
if(api.premiumAvailable)document.write('<script src="premium-runtime/renderer.js"><\/script>')
