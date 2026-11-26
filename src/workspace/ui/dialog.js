// Standalone dialog shared by the server editor, bastion prompts and account pages.
function showAccountDialog(content, title, className, onClose=()=>{}, {canClose=()=>true}={}) {
 const overlay=$('#modal'),previous=!overlay.hidden?{nodes:[...overlay.childNodes],mousedown:overlay.onmousedown}:null,focus=document.activeElement
 const close=()=>{if(!canClose())return;document.removeEventListener('keydown',keyHandler,true);if(typeof accountViews!=='undefined')for(const view of accountViews)if(content.contains(view.element)||content.contains(view.owner))accountViews.delete(view);if(previous){overlay.replaceChildren(...previous.nodes);overlay.onmousedown=previous.mousedown}else{overlay.replaceChildren();overlay.hidden=true;overlay.onmousedown=null}focus?.focus();onClose()}
 const keyHandler=event=>{
  if(!overlay.contains(card))return
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}
  if(event.key==='Tab'){
   const items=[...card.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(el=>el.getClientRects().length)
   const first=items[0],last=items.at(-1)
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }
 }
 const heading=h('h3',{id:'account-dialog-title',textContent:title})
 const card=h('section',{className:'card standalone-dialog '+className,role:'dialog',ariaModal:'true',ariaLabelledBy:'account-dialog-title'},h('div',{className:'standalone-head'},heading,h('button',{type:'button',className:'ib',innerHTML:icon('x'),ariaLabel:t('dialog.close'),title:t('dialog.close'),onclick:close})),h('div',{className:'standalone-body'},content))
 overlay.replaceChildren(card);overlay.hidden=false;overlay.onmousedown=event=>{if(event.target===overlay)close()};document.addEventListener('keydown',keyHandler,true)
 requestAnimationFrame(()=>(content.querySelector('input:not(:disabled)')||card.querySelector('button:not(:disabled)'))?.focus())
 return close
}
