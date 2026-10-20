/**
 * The buyer's Intake-2 page, served whole by this server at /intake/<token>
 * (14 Oct 2026). One self-contained HTML document: no login, no bundle, no
 * outside script. It reads its state from GET /api/public/intake-2/<token>,
 * uploads each file as it is chosen, and posts the answers once.
 *
 * The page knows a first name and an organisation and nothing else about the
 * lead. An unknown or wrong link gets the same plain "not valid" page, so a
 * link cannot be used to learn whether another one exists.
 *
 * Colours are the vFarm brand kit the Form A confirmation email uses: forest
 * header, paper body, gold button with black text.
 */
import { INTAKE2_FIELDS, INTAKE2_SECTIONS, INTAKE2_FILE_MAX_BYTES, INTAKE2_FILES_PER_FIELD } from '../../src/data/intake2';

const CSS = `
:root{--forest:#0f2419;--on-forest:#edebe3;--on-forest-dim:#c9d1c8;--lime:#c6f36b;--paper:#f2efe6;--card:#ffffff;--ink:#13170f;--muted:#5b5f55;--gold:#e0b84a;--gold-on:#0a0a0a;--gold-ink:#7d5e0d;--rule:#ddd8c9;--bad:#b42318;--bad-soft:#fdecea;--focus:#0a6ee6}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55}
header{background:var(--forest);color:var(--on-forest);padding:28px 16px}
.wrap{max-width:760px;margin:0 auto}
.brand{display:flex;align-items:center;gap:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--lime)}
.brand img{width:36px;height:36px;border-radius:8px;display:block}
h1{font-family:"Instrument Serif",Georgia,"Times New Roman",serif;font-weight:400;font-size:clamp(30px,6vw,40px);line-height:1.15;margin:18px 0 8px}
header p{margin:0;color:var(--on-forest-dim);max-width:60ch}
main{padding:24px 16px 64px}
.note{background:var(--card);border-left:4px solid var(--gold-ink);border-radius:8px;padding:14px 16px;font-size:14px;margin:0 0 20px}
section.card{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:20px 18px;margin:0 0 18px}
section.card h2{font-size:13px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:0 0 4px;font-weight:600}
.q{padding:16px 0;border-top:1px solid var(--rule)}
.q:first-of-type{border-top:0}
.q>label,.q>.label{display:block;font-weight:600;margin:0 0 8px}
.req{color:var(--gold-ink);font-weight:600;margin-left:4px}
.opt{color:var(--muted);font-weight:400;font-size:13px;margin-left:6px}
.hint{color:var(--muted);font-size:13px;margin:-4px 0 8px}
input[type=text],input[type=number],input[type=month],textarea,select{width:100%;font:inherit;color:inherit;background:#fff;border:1px solid #c9c4b4;border-radius:8px;padding:10px 12px}
textarea{min-height:96px;resize:vertical}
input:focus,textarea:focus,select:focus,button:focus-visible,.choice input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.choices{display:grid;gap:6px}
.choice{display:flex;gap:10px;align-items:flex-start;padding:6px 0;font-weight:400;cursor:pointer}
.choice input{margin-top:4px;width:18px;height:18px;flex:none}
.parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.parts label{display:block;font-size:14px;font-weight:500;margin:0 0 4px}
.detail{margin-top:10px}
.detail label{display:block;font-size:14px;font-weight:500;margin:0 0 4px}
.err{display:none;margin-top:8px;color:var(--bad);font-size:14px}
.q.bad .err{display:block}
.q.bad input,.q.bad textarea,.q.bad select{border-color:var(--bad)}
.files{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}
.files li{display:flex;justify-content:space-between;gap:10px;align-items:center;background:var(--paper);border-radius:8px;padding:8px 10px;font-size:14px;word-break:break-all}
.files button{background:none;border:0;color:var(--bad);font:inherit;font-size:13px;cursor:pointer;padding:4px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--gold);color:var(--gold-on);border:1px solid #b08a22;border-radius:8px;padding:13px 24px;font:inherit;font-weight:600;cursor:pointer;min-height:44px}
.btn[disabled]{opacity:.6;cursor:progress}
.banner{border-radius:10px;padding:14px 16px;margin:0 0 18px;font-size:15px}
.banner.bad{background:var(--bad-soft);color:var(--bad)}
.done{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:28px 22px}
.done h2{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:30px;margin:0 0 8px}
footer{color:var(--muted);font-size:13px;margin-top:28px}
footer a{color:var(--ink)}
.status{font-size:13px;color:var(--muted)}
`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="https://bhanetwork.org/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" rel="stylesheet">
<style>${CSS}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const HEADER = (title: string, lead: string) => `<header><div class="wrap">
<div class="brand"><img src="https://bhanetwork.org/icon-192.png" alt="BHA"><span>vFarm · Site &amp; deployment specification</span></div>
<h1>${esc(title)}</h1><p>${lead}</p></div></header>`;

/** For a link that does not open anything. Says nothing about why. */
/**
 * The same branded page for another buyer surface (17 Oct 2026: the Stage 3 proposal page).
 * `kicker` replaces "Site & deployment specification" in the header; `body` is trusted HTML
 * the caller has already escaped.
 */
export function brandedPage(kicker: string, title: string, lead: string, body: string): string {
  const header = `<header><div class="wrap">
<div class="brand"><img src="https://bhanetwork.org/icon-192.png" alt="BHA"><span>vFarm · ${esc(kicker)}</span></div>
<h1>${esc(title)}</h1><p>${lead}</p></div></header>`;
  return shell(title, `${header}<main><div class="wrap">${body}</div></main>`);
}
export const escapeHtml = esc;

export function notValidPage(): string {
  return shell(
    'Link not valid · vFarm',
    `${HEADER('This link is not valid', 'It may have been copied incompletely. Open the link from your invite email again, or reply to that email and we will help.')}
<main><div class="wrap"><footer><strong>Bays Horizon Network</strong> · <a href="https://bhanetwork.org/vfarm">bhanetwork.org/vfarm</a></footer></div></main>`,
  );
}

/** The form itself. The fields come from the contract file; the token is read from the address. */
export function formPage(): string {
  const schema = JSON.stringify({ fields: INTAKE2_FIELDS, sections: INTAKE2_SECTIONS, maxBytes: INTAKE2_FILE_MAX_BYTES, perField: INTAKE2_FILES_PER_FIELD }).replace(/</g, '\\u003c');
  const body = `${HEADER('Tell us about your site', 'These answers help BHA review whether, and how, a vFarm installation could work at your site. It takes about 20 minutes. Questions marked <span style="color:var(--lime)">*</span> are required; "Unknown" is a fine answer wherever it is offered.')}
<main><div class="wrap">
<div class="note">This is part of your Early Access interest only. Sending it is not a reservation, subscription, purchase or confirmation of availability, pricing or delivery. BHA will review it and reply.</div>
<div id="app"><p class="status">Loading…</p></div>
<footer><strong>Bays Horizon Network</strong> · <a href="https://bhanetwork.org/vfarm">bhanetwork.org/vfarm</a><br>Questions? Reply to your invite email.</footer>
</div></main>`;
  return shell('Site & deployment specification · vFarm', body, SCRIPT.replace('__SCHEMA__', schema));
}

/* The page's script. Plain ES2017, no dependencies. */
const SCRIPT = `
(function(){
var S=__SCHEMA__;
var token=location.pathname.split('/').filter(Boolean).pop()||'';
var api='/api/public/intake-2/'+encodeURIComponent(token);
var app=document.getElementById('app');
var files={};var DKEY='bha.intake2.'+token.slice(0,12);
function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a){if(k==='text')e.textContent=a[k];else if(k==='html')e.innerHTML=a[k];else e.setAttribute(k,a[k]);}(c||[]).forEach(function(x){if(x)e.appendChild(x)});return e;}
function fieldBy(n){for(var i=0;i<S.fields.length;i++)if(S.fields[i].n===n)return S.fields[i];}
function head(f){var l=el('div',{'class':'label',id:f.id+'-l'});l.appendChild(document.createTextNode(f.n+'. '+f.label));if(f.required)l.appendChild(el('span',{'class':'req','aria-hidden':'true',text:'*'}));else l.appendChild(el('span',{'class':'opt',text:'optional'}));return l;}
function input(type,name,extra){var a={type:type,name:name,id:name};for(var k in (extra||{}))a[k]=extra[k];return el('input',a);}
function select(name,opts,req){var s=el('select',{name:name,id:name});s.appendChild(el('option',{value:'',text:req?'Choose…':'Choose (optional)…'}));opts.forEach(function(o){s.appendChild(el('option',{value:o,text:o}))});return s;}
function choiceList(f,multi){var box=el('div',{'class':'choices',role:multi?'group':'radiogroup','aria-labelledby':f.id+'-l'});f.options.forEach(function(o,i){var id=f.id+'-o'+i;var c=el('label',{'class':'choice','for':id});var inp=input(multi?'checkbox':'radio',f.id+(multi?'[]':''),{value:o,id:id});c.appendChild(inp);c.appendChild(el('span',{text:o}));box.appendChild(c);});return box;}
function render(state){
  app.innerHTML='';
  if(state.submitted){done(state.submitted_at,true);return;}
  var form=el('form',{novalidate:'novalidate'});
  var banner=el('div',{'class':'banner bad',role:'alert',style:'display:none'});form.appendChild(banner);
  form.appendChild(el('p',{text:'Hi '+state.first_name+(state.organisation?' ('+state.organisation+')':'')+', thanks for taking the time.'}));
  S.sections.forEach(function(sec){
    var card=el('section',{'class':'card'});card.appendChild(el('h2',{text:sec.title}));
    sec.fields.forEach(function(n){card.appendChild(question(fieldBy(n),state));});
    form.appendChild(card);
  });
  var btn=el('button',{'class':'btn',type:'submit',text:'Send my site specification'});
  form.appendChild(btn);
  form.addEventListener('submit',function(ev){ev.preventDefault();send(form,btn,banner);});
  form.addEventListener('input',function(){saveDraft(form)});form.addEventListener('change',function(){saveDraft(form)});
  app.appendChild(form);loadDraft(form);
}
function question(f,state){
  var q=el('div',{'class':'q',id:'q'+f.n});q.appendChild(head(f));
  if(f.hint)q.appendChild(el('p',{'class':'hint',text:f.hint}));
  if(f.kind==='longtext'){q.appendChild(el('textarea',{name:f.id,id:f.id,'aria-labelledby':f.id+'-l'}));}
  else if(f.kind==='integer'){q.appendChild(input('number',f.id,{min:String(f.min),step:'1',inputmode:'numeric','aria-labelledby':f.id+'-l'}));}
  else if(f.kind==='select'||f.kind==='multi'){q.appendChild(choiceList(f,f.kind==='multi'));if(f.detail){var d=el('div',{'class':'detail',id:f.id+'-dw'});d.appendChild(el('label',{'for':f.id+'-d',text:f.detail.label+(f.detail.when?' (if '+f.detail.when+')':'')}));d.appendChild(input('text',f.id+'-d'));q.appendChild(d);}}
  else if(f.kind==='group'){var g=el('div',{'class':'parts'});f.parts.forEach(function(p){var w=el('div');var nm=f.id+'-'+p.key;w.appendChild(el('label',{'for':nm,text:p.label+(p.required?' *':'')}));if(p.kind==='select')w.appendChild(select(nm,p.options,p.required));else if(p.kind==='multi'){var mb=el('div',{'class':'choices'});p.options.forEach(function(o,i){var id=nm+'-o'+i;var c=el('label',{'class':'choice','for':id});c.appendChild(input('checkbox',nm+'[]',{value:o,id:id}));c.appendChild(el('span',{text:o}));mb.appendChild(c);});w.appendChild(mb);}else w.appendChild(input(p.kind==='number'?'number':p.kind==='month'?'month':'text',nm,p.kind==='number'?{min:'0',step:'any',inputmode:'decimal'}:(p.hint?{placeholder:p.hint}:{})));if(p.hint&&p.kind!=='text')w.appendChild(el('p',{'class':'hint',style:'margin:4px 0 0',text:p.hint}));g.appendChild(w);});q.appendChild(g);}
  else if(f.kind==='file'){files[f.n]=(state.uploads||[]).filter(function(u){return u.field===f.n}).map(function(u){return {file_id:u.file_id,name:u.name,size:u.size}});q.appendChild(el('p',{'class':'hint',text:'PDF, JPG or PNG, up to '+Math.round(S.maxBytes/1048576)+' MB each, up to '+S.perField+' files.'}));var inp=input('file',f.id,{accept:'application/pdf,image/jpeg,image/png',multiple:'multiple','aria-labelledby':f.id+'-l'});var list=el('ul',{'class':'files','aria-live':'polite'});inp.addEventListener('change',function(){upload(f,inp,list,q)});q.appendChild(inp);q.appendChild(list);drawFiles(f,list);}
  q.appendChild(el('div',{'class':'err',id:'e'+f.n,role:'alert'}));
  return q;
}
function drawFiles(f,list){list.innerHTML='';(files[f.n]||[]).forEach(function(x,i){var li=el('li');li.appendChild(el('span',{text:x.name+(x.pending?' (uploading…)':'')}));if(!x.pending){var b=el('button',{type:'button',text:'Remove'});b.addEventListener('click',function(){files[f.n].splice(i,1);drawFiles(f,list)});li.appendChild(b);}list.appendChild(li);});}
function upload(f,inp,list,q){
  var chosen=Array.prototype.slice.call(inp.files||[]);inp.value='';q.classList.remove('bad');
  chosen.reduce(function(p,file){return p.then(function(){
    if((files[f.n]||[]).length>=S.perField){return fail(q,f,'Up to '+S.perField+' files here.');}
    if(['application/pdf','image/jpeg','image/png'].indexOf(file.type)<0){return fail(q,f,file.name+': only PDF, JPG and PNG files can be uploaded.');}
    if(file.size>S.maxBytes){return fail(q,f,file.name+' is over '+Math.round(S.maxBytes/1048576)+' MB.');}
    var item={name:file.name,size:file.size,pending:true};files[f.n]=(files[f.n]||[]).concat([item]);drawFiles(f,list);
    return fetch(api+'/file?field='+f.n,{method:'POST',headers:{'content-type':file.type,'x-file-name':encodeURIComponent(file.name)},body:file}).then(function(r){return r.json().then(function(b){return {r:r,b:b}})}).then(function(x){
      var arr=files[f.n];var i=arr.indexOf(item);
      if(!x.r.ok||!x.b.ok){if(i>=0)arr.splice(i,1);drawFiles(f,list);return fail(q,f,(x.b&&x.b.message)||'That file could not be uploaded.');}
      arr[i]={file_id:x.b.file.file_id,name:x.b.file.name,size:x.b.file.size};drawFiles(f,list);
    }).catch(function(){var arr=files[f.n];var i=arr.indexOf(item);if(i>=0)arr.splice(i,1);drawFiles(f,list);fail(q,f,'That file could not be uploaded. Check your connection and try again.');});
  })},Promise.resolve());
}
function fail(q,f,msg){q.classList.add('bad');document.getElementById('e'+f.n).textContent=msg;}
function collect(form){
  var fd=form.elements,out={};
  S.fields.forEach(function(f){
    if(f.kind==='longtext'||f.kind==='integer'){out[f.id]=(fd[f.id]||{}).value||'';}
    else if(f.kind==='select'){var c=form.querySelector('input[name="'+f.id+'"]:checked');out[f.id]={choice:c?c.value:'',detail:fd[f.id+'-d']?fd[f.id+'-d'].value:''};}
    else if(f.kind==='multi'){out[f.id]={choices:Array.prototype.map.call(form.querySelectorAll('input[name="'+f.id+'[]"]:checked'),function(x){return x.value}),detail:fd[f.id+'-d']?fd[f.id+'-d'].value:''};}
    else if(f.kind==='group'){var o={};f.parts.forEach(function(p){var nm=f.id+'-'+p.key;if(p.kind==='multi')o[p.key]=Array.prototype.map.call(form.querySelectorAll('input[name="'+nm+'[]"]:checked'),function(x){return x.value});else o[p.key]=(fd[nm]||{}).value||'';});out[f.id]=o;}
    else if(f.kind==='file'){out[f.id]=(files[f.n]||[]).filter(function(x){return x.file_id}).map(function(x){return x.file_id});}
  });
  return out;
}
function saveDraft(form){try{var a=collect(form);S.fields.forEach(function(f){if(f.kind==='file')delete a[f.id]});localStorage.setItem(DKEY,JSON.stringify(a));}catch(e){}}
function loadDraft(form){var a;try{a=JSON.parse(localStorage.getItem(DKEY)||'null');}catch(e){a=null}if(!a)return;var fd=form.elements;
  S.fields.forEach(function(f){var v=a[f.id];if(v==null)return;
    if(f.kind==='longtext'||f.kind==='integer'){if(fd[f.id])fd[f.id].value=v;}
    else if(f.kind==='select'||f.kind==='multi'){var set=f.kind==='select'?[v.choice]:(v.choices||[]);Array.prototype.forEach.call(form.querySelectorAll('input[name="'+f.id+(f.kind==='multi'?'[]':'')+'"]'),function(x){x.checked=set.indexOf(x.value)>=0});if(fd[f.id+'-d'])fd[f.id+'-d'].value=v.detail||'';}
    else if(f.kind==='group'){f.parts.forEach(function(p){var nm=f.id+'-'+p.key;if(p.kind==='multi'){Array.prototype.forEach.call(form.querySelectorAll('input[name="'+nm+'[]"]'),function(x){x.checked=(v[p.key]||[]).indexOf(x.value)>=0});}else if(fd[nm])fd[nm].value=v[p.key]||'';});}
  });}
function send(form,btn,banner){
  if(Object.keys(files).some(function(k){return files[k].some(function(x){return x.pending})})){banner.style.display='block';banner.textContent='A file is still uploading. Wait a moment, then send.';return;}
  Array.prototype.forEach.call(form.querySelectorAll('.q.bad'),function(q){q.classList.remove('bad')});banner.style.display='none';
  btn.disabled=true;btn.textContent='Sending…';
  fetch(api,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answers:collect(form)})}).then(function(r){return r.json().then(function(b){return {r:r,b:b}})}).then(function(x){
    if(x.r.ok&&x.b.ok){try{localStorage.removeItem(DKEY)}catch(e){}done(x.b.submitted_at,false);window.scrollTo(0,0);return;}
    btn.disabled=false;btn.textContent='Send my site specification';
    banner.style.display='block';banner.textContent=(x.b&&x.b.message)||'Something went wrong. Please try again.';
    (x.b.errors||[]).forEach(function(e){var q=document.getElementById('q'+e.field);if(q){q.classList.add('bad');document.getElementById('e'+e.field).textContent=e.message;}});
    var first=form.querySelector('.q.bad');(first||banner).scrollIntoView({behavior:'smooth',block:'center'});
  }).catch(function(){btn.disabled=false;btn.textContent='Send my site specification';banner.style.display='block';banner.textContent='Could not reach BHA. Check your connection and try again; your answers are kept on this device.';});
}
function done(at,earlier){app.innerHTML='';var d=el('div',{'class':'done'});d.appendChild(el('h2',{text:'Thank you, we have your site specification'}));d.appendChild(el('p',{text:(earlier?'We received it on ':'Received ')+new Date(at).toLocaleString()+'. BHA will review it and reply by email.'}));d.appendChild(el('p',{text:'This is part of your Early Access interest only. It is not a reservation, subscription, purchase or confirmation of availability, pricing or delivery. To change an answer, reply to your invite email.'}));app.appendChild(d);}
fetch(api).then(function(r){if(r.status===404){app.innerHTML='';app.appendChild(el('p',{'class':'banner bad',text:'This link is not valid. Open it again from your invite email, or reply to that email.'}));return null;}return r.json()}).then(function(b){if(!b)return;if(!b.ok){app.innerHTML='';app.appendChild(el('p',{'class':'banner bad',text:b.message||'This form could not be loaded.'}));return;}render(b);}).catch(function(){app.innerHTML='';app.appendChild(el('p',{'class':'banner bad',text:'Could not reach BHA. Check your connection and reload the page.'}));});
})();
`;
