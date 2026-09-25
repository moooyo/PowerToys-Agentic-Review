(function () {
  'use strict';
  const root = document.getElementById('ar-m3-prototype');
  if (!root) return;
  const $ = (id) => root.querySelector('#' + CSS.escape(String(id)));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (name) => `<i data-lucide="${esc(name)}" aria-hidden="true" class="ar-icon"></i>`;
  const button = (text, action, variant = '', attrs = '') => `<button type="button" class="ar-btn ${esc(variant)}" data-action="${esc(action)}" ${attrs}>${text}</button>`;
  const badge = (text, tone = 'neutral') => `<span class="ar-badge ${esc(tone)}">${esc(text)}</span>`;
  const notice = (text, tone = 'info') => `<div class="ar-notice ${esc(tone)}" ${tone === 'error' ? 'role="alert"' : ''}>${text}</div>`;
  const field = (label, id, value = '', type = 'text', extra = '') => `<label class="ar-field" for="${esc(id)}">${esc(label)}<input id="${esc(id)}" aria-label="${esc(label)}" type="${esc(type)}" value="${esc(value)}" ${extra}></label>`;
  const select = (label, id, choices, selected) => `<label class="ar-field" for="${id}">${label}<select id="${id}" aria-label="${esc(label)}">${choices.map(c => {const [v,t] = Array.isArray(c) ? c : [c,c]; return `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(t)}</option>`;}).join('')}</select></label>`;
  const heading = (title, subtitle = '', actions = '') => `<div class="ar-heading"><div><h1>${esc(title)}</h1>${subtitle?`<p>${subtitle}</p>`:''}</div>${actions ? `<div class="ar-row">${actions}</div>` : ''}</div>`;
  const tabs = (items, active, prefix) => `<nav class="ar-tabs" aria-label="Detail sections">${items.map(i=>`<button type="button" data-action="${esc(prefix+i.id)}" ${i.id === active?'aria-current="page"':''}>${esc(i.label)}</button>`).join('')}</nav>`;
  const empty = (title, description, actionHtml = '') => `<div class="ar-empty"><span class="ar-empty-icon">${icon('inbox')}</span><h2>${esc(title)}</h2><p>${description}</p>${actionHtml}</div>`;
  function githubLink(record) {
    const repository=record.repositoryFullName||record.repository?.fullName||'',number=Number(record.workItem?.number??record.number),kind=record.workItem?.kind||record.type||record.kind;
    const path=['pulls','pull','pr','PR','PullRequest','pull_request'].includes(kind)?'pull':['issues','issue','Issue'].includes(kind)?'issues':null;
    const segments=repository.split('/'),valid=segments.length===2&&segments.every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&!['.','..'].includes(part));
    if(!valid||!path||!Number.isSafeInteger(number)||number<1)return '<span class="ar-small ar-muted">GitHub target unavailable · source metadata missing</span>';
    const label=(path==='pull'?'PR':'Issue')+' #'+number,url='https://github.com/'+segments.map(encodeURIComponent).join('/')+'/'+path+'/'+number;
    return `<span class="ar-github-entry"><a class="ar-btn ghost small" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open GitHub ${esc(label)}${record.synthetic?' (sample target)':''} in a new tab">${icon('external-link')}GitHub ${esc(label)}</a>${record.synthetic?'<span class="ar-github-note">Sample target</span>':''}</span>`;
  }
  const h = {esc,icon,button,badge,notice,field,heading,tabs,empty,githubLink};
  const names = {pulls:'Pull requests',issues:'Issues',tasks:'Tasks',reports:'Reports',comments:'Comments',webhooks:'Webhook events',repositories:'Repositories',workers:'Workers',accounts:'Accounts',account:'My account',login:'Sign in'};
  const originalCommit='a4d71e2'+'0'.repeat(33);
  const groups = [{id:'review',label:'Review',icon:'git-pull-request',pages:['pulls','issues','reports']},{id:'tasks',label:'Tasks',icon:'list-checks',pages:['tasks']},{id:'activity',label:'Activity',icon:'messages-square',pages:['comments','webhooks']},{id:'workspace',label:'Workspace',icon:'settings-2',pages:['repositories','workers','accounts']}];
  const fixtures = [
    {id:'2101',type:'pulls',title:'Preserve settings when a migration is cancelled',status:'Completed',conclusion:'2 findings',validation:'Not run',priority:'P1',mode:'Static',tokens:18300},
    {id:'2102',type:'pulls',title:'Improve keyboard navigation in Command Palette',status:'Completed',conclusion:'26 findings',validation:'Not run',priority:'P0',mode:'Static',tokens:28400},
    {id:'2203',type:'pulls',title:'Inspect an in-progress synthetic E2E capture',status:'Running',conclusion:'In progress',validation:'In progress',mode:'E2E',tokens:null},
    {id:'2202',type:'pulls',title:'E2E preflight requires a build prerequisite',status:'Blocked',conclusion:'Partial report',validation:'Blocked',mode:'E2E',tokens:0},
    {id:'2103',type:'pulls',title:'Keep command search history across updates',status:'Interrupted',conclusion:'Checkpoint',validation:'Not run',mode:'Static',tokens:20000},
    {id:'2201',type:'pulls',title:'Verify the synthetic settings interaction',status:'Needs review',conclusion:'No report',validation:'Not run',mode:'E2E',tokens:0},
    {id:'3101',type:'issues',title:'Settings does not open after an update',status:'Completed',conclusion:'Needs verification',validation:'Not run',kind:'Bug',mode:'Static',tokens:14200},
    {id:'3102',type:'issues',title:'Export a selected subset of Settings',status:'Completed',conclusion:'Needs decision',validation:'Not applicable',kind:'Feature',mode:'Static',tokens:9800}
  ].map(record=>({...record,number:Number(record.id),repositoryFullName:'example/dashboard-ui-fixture',synthetic:true}));
  // A saved report keeps its own execution result even when its task resumes.
  const reportSnapshots = Object.freeze(Object.fromEntries(fixtures.filter(x=>x.conclusion!=='No report').map(x=>[x.id,Object.freeze({...x,status:x.status==='Running'?'Interrupted':x.status,conclusion:x.status==='Running'?'Saved checkpoint':x.conclusion,validation:x.status==='Running'?'Not run':x.validation,completeness:x.status==='Completed'?'Complete':'Partial',delivery:x.status==='Completed'?'Final':'Checkpoint'})])));
  // Saved assessment is explicit data, independent of execution and finding count.
  const savedAssessments=Object.freeze({
    '2101':{status:'changes-requested',label:'Changes needed',rationale:'Two source-confirmed P1 defects can overwrite or leave incomplete settings when migration is cancelled.',validation:'Required E2E: Not run',next:'Prepare request changes',action:'request-changes',reason:'Ask the author to protect the saved configuration, then verify cancellation against the exact revision.'},
    '2102':{status:'changes-requested',label:'Changes needed',rationale:'The review retained 26 findings, including an unresolved P0 that can delete the persisted configuration.',validation:'Required E2E: Not run',next:'Prepare request changes',action:'request-changes',reason:'Resolve the P0 before approval. Recheck the fix and complete the outstanding runtime validation.'},
    '2103':{status:'inconclusive',label:'No final conclusion',rationale:'The saved checkpoint covers only part of the change. The investigation stopped at its token limit.',validation:'Validation: Not run',next:'Review resume budget',action:'resume',reason:'Raise the exhausted limit and continue with the same frozen source and saved checkpoint.'},
    '2202':{status:'inconclusive',label:'No final conclusion',rationale:'Preflight could not establish the required build prerequisite. No runtime result was accepted.',validation:'Validation: Blocked',next:'Inspect prerequisites',action:'prerequisites',reason:'Repair the pinned toolchain, then check prerequisites before resuming the saved plan.'},
    '2203':{status:'inconclusive',label:'No final conclusion',rationale:'This saved checkpoint predates the current E2E attempt. A running capture is not a passed check.',validation:'Saved validation: Not run',next:'Follow latest attempt',action:'progress',reason:'Wait for the current attempt to produce an accepted result and a new saved report.'},
    '3101':{status:'needs_verification',label:'Needs verification',rationale:'The reported Settings startup failure is plausible. Runtime reproduction and the root cause remain unconfirmed.',validation:'Reproduction: Not run',next:'Prepare verification',action:'verification',reason:'Review the saved reproduction plan and choose an exact source commit before checking execution prerequisites.'},
    '3102':{status:'needs_decision',label:'Needs decision',rationale:'Selective export needs maintainer decisions on dependencies, defaults and compatibility before implementation.',validation:'Plan: Draft · Acceptance: Not recorded',next:'Prepare clarification comment',action:'clarify',reason:'Confirm dependent-setting behavior and compatibility with existing imports. The draft plan can then be finalized.'}
  });
  const assessmentFor=x=>savedAssessments[x.id]||{status:'not_assessed',label:'No conclusion yet',rationale:'No saved investigation report is available for this source.',validation:'Validation: Not run',next:'Start investigation',action:'start',reason:'Investigate the saved source before deciding on a repository action.'};
  const state = {page:'pulls',id:null,tab:'overview',role:'admin',scenario:'normal',repo:'all',q:'',ops:{},lists:{},queue:null,viewEpoch:0,recordViews:{},dirty:false,reportDirty:false,selected:{},drafts:{},savedDrafts:{},actionDrafts:{},actionIntents:{},startDrafts:{},startRequests:{},resumeDrafts:{},taskBudgets:{},finding:1,findingPage:1,severity:'all',findingQuery:'',findingStatus:'all',indexExpanded:false,reportToolsOpen:false,taskOutputQuery:'',eventType:'all',attempt:'1',follow:true,preview:null,nextIntent:1,history:[],theme:'auto',toast:'',lastSuccess:'21 Sep 2026, 09:30'};
  const design = {compact:false,expanded:false,validation:true};
  let pendingNavigation = null;
  let pendingDialog = null;
  let dialogDirty = false;
  let coreForm = null;
  let routePosition = 0;
  let historyTraversal = null;
  let lastFocus = null;
  let lastFocusKey = null;
  let lastRenderedRoute = '';
  let guardScope = 'all';
  let dialogSourceId = null;
  let dialogOrigin = null;
  const fresh = () => state.scenario !== 'refresh-error';
  const item = () => fixtures.find(x=>x.id === (dialogSourceId||(state.page==='tasks'?state.followupTasks?.[state.id]?.sourceId||state.id:state.id))) || fixtures[0];
  const sourceKey = (x=item()) => x.type+':'+x.id;
  const pendingIntent = (x=item()) => state.actionIntents[sourceKey(x)]?.status==='unknown'?state.actionIntents[sourceKey(x)]:null;
  const ownsIntent = intent => Boolean(intent&&canReadSource()&&intent.actorId===currentAccount()?.id);
  const taskBudget = (x=item()) => state.taskBudgets[sourceKey(x)] ||= {tokens:Math.max(20000,x.tokens||0),rounds:8,minutes:30,report:2};
  const taskConsumption = (x=item()) => ({tokens:x.id==='2103'?20000:x.tokens||0,rounds:x.id==='2103'?5:x.status==='Blocked'?0:2,minutes:x.id==='2103'?18:x.status==='Blocked'?1:10,report:x.id==='2103'?0.7:0.2});
  const taskSummary = (x=item()) => ({savedResult:reportSnapshots[x.id]?assessmentFor(x).label+' · '+reportSnapshots[x.id].completeness:'No saved report',validation:x.status==='Cancelled'&&x.validation==='In progress'?'No accepted result':x.validation});
  const tone = s => /Failed|Blocked|Interrupted|Not run|No accepted result|Needs verification|Partial|Not reproduced/.test(s) ? 'warning' : /Running|Queued|In progress/.test(s) ? 'info' : /Completed|Synced|Passed/.test(s) ? 'success' : 'neutral';
  const currentAccount = () => !state.ops.signedOut?state.ops.accounts?.find(a=>a.id===(state.ops.sessionAccountId||{admin:'acct-admin',preparer:'acct-reviewer',reader:'acct-reader'}[state.role])):undefined;
  const accountInitials = () => (currentAccount()?.displayName||currentAccount()?.username||'Demo').trim().split(/\s+/).slice(0,2).map(word=>word[0]||'').join('').toUpperCase();
  const canReadSource = () => currentAccount()?.enabled && currentAccount().repositories.split(/[\s,]+/).includes('repo-fixture');
  const can = permission => Boolean(currentAccount()?.enabled&&currentAccount().permissions.includes(permission)&&canReadSource());
  const canResume = () => can('task:create')&&(item().mode!=='E2E'||currentAccount()?.execution);
  const actionCapability = (operation,x=item()) => ({suggestion:'suggestion-comment',ci:'trigger-ci',followup:x.type==='issues'?'start-task':'reviews.verify'}[operation]||operation);
  function prepareOperationReason(operation,x=item()) {
    if(!can('action:prepare'))return 'Preparation requires action:prepare for this repository.';
    const capability=actionCapability(operation,x);
    if(!currentAccount()?.capabilities.includes(capability))return 'Preparation requires the '+capability+' capability for this repository.';
    if(operation==='followup'&&(!can('task:create')||!currentAccount()?.execution))return 'Preparing a follow-up requires task:create and a repository execution grant.';
    return '';
  }
  const canExecute = operation => can('action:execute')&&currentAccount().capabilities.includes(actionCapability(operation))&&(operation!=='followup'||can('task:create')&&currentAccount().execution);
  const permitted = p => !['workers','accounts'].includes(p) || Boolean(currentAccount()?.enabled&&currentAccount().isAdmin);
  function currentList() {return state.lists[state.page] ||= {q:'',status:'all',source:'all',type:'all',delivery:'all',page:1,scroll:0};}
  function restoreScroll(top=0,{restoreList=false,opener=null}={}) {
    const route=state.page+':'+(state.id||'')+':'+state.repo;
    requestAnimationFrame(()=>{if(route!==state.page+':'+(state.id||'')+':'+state.repo)return;window.scrollTo(0,top);if(restoreList)focusListReturn(opener);syncRoute(true,window.scrollY);});
  }
  function listPage(found) {const f=currentList();f.page=Math.max(1,Math.min(f.page,Math.ceil(found.length/4)||1));return found.slice((f.page-1)*4,f.page*4);}
  function listPager(count) {const f=currentList(),pages=Math.ceil(count/4)||1;return `<div class="ar-pager"><span>${(f.page-1)*4+1}–${Math.min(f.page*4,count)} of ${count}</span><div class="ar-row">${button('Previous page','list-prev','small',f.page===1?'disabled':'')}${button('Next page','list-next','small',f.page===pages?'disabled':'')}</div></div>`;}
  let toastTimer,toastFocus;
  function dismissIdleToast() {const toastNode=$('ar-toast');if(toastNode.matches(':hover')||toastNode.contains(document.activeElement)){toastTimer=setTimeout(dismissIdleToast,8000);return;}clearToast();}
  function toast(message) {clearTimeout(toastTimer);state.toast=message;toastFocus=focusKey();const toastNode=$('ar-toast');($('ar-dialog').open?$('ar-dialog'):root.querySelector('.ar-app')).append(toastNode);toastNode.hidden=false;toastNode.innerHTML=`<span>${esc(message)}</span>${button(icon('x'),'dismiss-toast','ghost small','aria-label="Dismiss notification"')}`;paintIcons();toastTimer=setTimeout(dismissIdleToast,8000);}
  function clearToast() {clearTimeout(toastTimer);state.toast='';const toastNode=$('ar-toast'),focused=toastNode.contains(document.activeElement);toastNode.hidden=true;if(focused&&!focusByKey(toastFocus)){if($('ar-dialog').open)$('ar-dialog-foot').querySelector('button:not(:disabled)')?.focus({preventScroll:true});else focusMain();}}
  function draftBaseline(key) {const [id,finding]=key.split(':');return state.savedDrafts[key]??findingsFor(reportSnapshots[id]||fixtures.find(x=>x.id===id)||fixtures[0]).find(f=>f.id===Number(finding))?.feedback??'';}
  function isDraftChanged(key) {return state.drafts[key]!==draftBaseline(key);}
  function updateDirty() {state.reportDirty=Object.keys(state.drafts).some(isDraftChanged);state.dirty=state.reportDirty||Boolean(state.ops.dirty);}
  function markDirty(value = true) {state.ops.dirty=Boolean(value);updateDirty();}
  function clearDirty() {state.ops.dirty=false;updateDirty();}
  function clearPrivateSession() {
    dialogSourceId=null;
    dialogOrigin=null;
    delete state.ops.sessionAccountId;
    state.selected={};state.drafts={};state.savedDrafts={};state.actionDrafts={};state.publicationDrafts={};state.startDrafts={};state.resumeDrafts={};
    state.queue=null;state.viewEpoch++;state.recordViews={};
    Object.values(state.lists).forEach(list=>{delete list.opener;});
    Object.keys(state.actionIntents).forEach(key=>{if(state.actionIntents[key].status!=='unknown')delete state.actionIntents[key];});
    state.preview=null;pendingNavigation=null;pendingDialog=null;pendingReplacement=null;dialogDirty=false;coreForm=null;updateDirty();
    if($('ar-dialog').open)closeDialog();
    $('ar-dialog-title').textContent='';$('ar-dialog-body').replaceChildren();$('ar-dialog-foot').replaceChildren();
  }
  function focusKey(el=document.activeElement) {return el&&root.contains(el)?{id:el.id||null,action:el.dataset?.action||null,region:el.closest('#ar-main,#ar-nav,#ar-dialog')?.id||null}:null;}
  function focusByKey(key) {const scope=key?.region?$(key.region)||root:root;const target=key?.id?$(key.id):key?.action?Array.from(scope.querySelectorAll('[data-action]')).find(el=>el.dataset.action===key.action&&!el.disabled):null;if(target&&!target.disabled&&target.getClientRects().length>0&&!target.closest('[hidden]')&&(!$('ar-dialog').open||$('ar-dialog').contains(target))){target.focus({preventScroll:true});return true;}return false;}
  function focusMain() {const main=$('ar-main');const target=Array.from(main?.querySelectorAll('.ar-back button:not(:disabled), .ar-heading button:not(:disabled), input:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]')||[]).find(el=>el.getClientRects().length>0&&!el.closest('[hidden]'));target?.focus({preventScroll:true});}
  function listOpener(key,page=state.page) {
    if(!key||typeof key.action!=='string'||!/^(open|recommended):(pulls|issues|tasks|reports):[A-Za-z0-9_-]{1,64}$/.test(key.action))return null;
    const [verb,targetPage,id]=key.action.split(':');if(targetPage!==page)return null;
    return {id:(verb==='recommended'?'ar-row-action-':'ar-source-')+page+'-'+id,action:key.action,region:'ar-main'};
  }
  function focusListReturn(opener) {
    const main=$('ar-main'),height=window.innerHeight||document.documentElement?.clientHeight||1000,width=window.innerWidth||document.documentElement?.clientWidth||1000;
    const visible=(el,fully=false)=>{if(!el||el.disabled)return false;const rect=el.getBoundingClientRect();return rect.width>0&&rect.height>0&&(fully?rect.top>=0&&rect.bottom<=height:rect.bottom>0&&rect.top<height)&&rect.right>0&&rect.left<width;};
    const key=listOpener(opener),original=key?$(key.id):null;
    if(visible(original)){original.focus({preventScroll:true});return;}
    const rows=Array.from(main.querySelectorAll('button.ar-source-row:not(:disabled),button.ar-source-open:not(:disabled)'));
    const controls=Array.from(main.querySelectorAll('.ar-pager button:not(:disabled),input:not(:disabled),select:not(:disabled),.ar-toolbar button:not(:disabled),.ar-heading button:not(:disabled)'));
    const target=rows.find(el=>visible(el,true))||rows.find(el=>visible(el))||controls.find(el=>visible(el,true))||controls.find(el=>visible(el));
    if(target){target.focus({preventScroll:true});return;}
    const fallback=$('ar-list-search')||controls[0]||main.querySelector('button:not(:disabled),a[href]');
    fallback?.scrollIntoView({block:'nearest'});fallback?.focus({preventScroll:true});
  }
  function paintIcons() {globalThis.ARMaterialNavigation?.sync(root);globalThis.ARMaterialAssets?.paintIcons(root);globalThis.ARMaterialControls?.sync();}
  function download(name, contents) {
    const blob = new Blob([typeof contents === 'string' ? contents : JSON.stringify(contents,null,2)],{type:name.endsWith('.json')?'application/json':'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('Downloaded synthetic ' + name);
  }
  function openDialog(title, body, footer = button('Close','dialog-close'),focusAction=null) {
    globalThis.ARMaterialControls?.closeMenus();
    $('ar-dialog').classList.remove('ar-publish-dialog');
    if (!$('ar-dialog').open) {lastFocus = document.activeElement;lastFocusKey=focusKey();}
    dialogDirty=false; coreForm=null;
    $('ar-dialog-title').textContent=title; $('ar-dialog-body').innerHTML=body; $('ar-dialog-foot').innerHTML=footer;
    if (!$('ar-dialog').open) $('ar-dialog').showModal();
    paintIcons();
    $('ar-dialog').scrollTop=0;$('ar-dialog-body').scrollTop=0;
    const visible=el=>!el.disabled&&el.getClientRects().length>0;
    const target=(focusAction?Array.from($('ar-dialog').querySelectorAll('[data-action]')).find(el=>el.dataset.action===focusAction&&visible(el)):null)||Array.from($('ar-dialog-body').querySelectorAll('input:not([type="hidden"]),textarea,select,button,a[href]')).find(visible)||$('ar-dialog-foot').querySelector('button:not(:disabled)');
    target?.focus({preventScroll:!focusAction});if(focusAction)target?.scrollIntoView({block:'nearest'});
  }
  function closeDialog() { globalThis.ARMaterialControls?.closeMenus();root.querySelector('.ar-app').append($('ar-toast'));$('ar-dialog').close(); dialogSourceId=null;dialogOrigin=null;dialogDirty=false; coreForm=null; pendingReplacement=null; if(lastFocus?.isConnected&&!lastFocus.disabled&&lastFocus.getClientRects().length>0)lastFocus.focus({preventScroll:true});else if(!focusByKey(lastFocusKey)){if(lastFocusKey?.action?.startsWith('recommended:')&&!state.id)focusListReturn(null);else focusMain();} }
  function discardCoreForm(form) {
    if (!form) return;
    const stores={prepare:state.actionDrafts,start:state.startDrafts,resume:state.resumeDrafts,followup:state.actionDrafts};
    if (stores[form.kind]) stores[form.kind][form.key]={...form.initial};
  }
  function guardNavigation(callback,scope='all') {
    if ((scope==='all'&&state.dirty) || dialogDirty) {
      guardScope=scope;
      pendingNavigation=callback;
      if ($('ar-dialog').open && $('ar-dialog-title').textContent !== 'Leave unsaved changes?') {
        // Retain native controls themselves so ephemeral password values never become serialized state.
        pendingDialog={title:$('ar-dialog-title').textContent,bodyNodes:Array.from($('ar-dialog-body').childNodes),footerNodes:Array.from($('ar-dialog-foot').childNodes),dirty:dialogDirty,form:coreForm,focus:focusKey()};
      }
      openDialog('Leave unsaved changes?',notice(scope==='dialog'?'Leave without saving this dialog?':'Leave without saving your changes?','warning'),button('Keep editing','guard-stay')+button('Discard and leave','guard-discard','danger'),'guard-stay');
    } else callback();
  }
  const corePages=['pulls','issues','tasks','reports'];
  const listDefaults=()=>({q:'',status:'all',source:'all',type:'all',delivery:'all',page:1,scroll:0});
  const textParam=v=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160):'';
  const enumParam=(v,values,fallback)=>values.includes(v)?v:fallback;
  const intParam=(v,fallback=1,max=10000)=>/^\d{1,6}$/.test(String(v))?Math.max(1,Math.min(max,Number(v))):fallback;
  const hasRecord=(page,id)=>page==='reports'?Boolean(reportSnapshots[String(id)]):page==='tasks'&&Boolean(state.followupTasks?.[String(id)])||fixtures.some(x=>x.id===String(id)&&(page==='tasks'?x.status!=='Needs review':page==='pulls'||page==='issues'?x.type===page:true));
  const ownerWorker=(x=item())=>state.ops.workers?.find(w=>String(w.owner||'').replace(/^task-/,'')===x.id);
  function matchedSources(page=state.page,filter=state.lists[page]||listDefaults()) {
    if(state.repo==='fork'||!canReadSource())return [];
    const records=page==='reports'?Object.values(reportSnapshots):page==='tasks'?[...followups.list(),...fixtures]:fixtures;
    return records.filter(x=>{
      if(!(x.title+' '+x.id+' '+(x.number||x.id)).toLowerCase().includes(filter.q.toLowerCase()))return false;
      if(page==='pulls'||page==='issues')return x.type===page&&(filter.status==='all'||x.status===filter.status)&&(filter.source==='all'||filter.source==='open'&&publication.sourceState(x)==='Open'||filter.source==='closed'&&publication.sourceState(x)!=='Open');
      if(page==='tasks')return x.status!=='Needs review'&&(filter.status==='all'||filter.status==='active'&&['Running','Queued','Cancelling'].includes(x.status)||filter.status==='attention'&&['Blocked','Interrupted','Failed'].includes(x.status));
      return (filter.status==='all'||filter.status==='partial'&&x.completeness==='Partial'||filter.status==='complete'&&x.completeness==='Complete')&&(filter.type==='all'||(filter.type==='pulls'?x.type==='pulls':x.kind===filter.type))&&(filter.delivery==='all'||x.delivery===filter.delivery);
    });
  }
  function saveRecordView() {
    if(!state.id||!corePages.includes(state.page))return;
    if(state.page==='tasks'&&!hasRecord('tasks',state.id))return;
    state.recordViews[state.page+':'+state.id]={tab:state.tab,...(state.page==='reports'?{finding:state.finding,findingPage:state.findingPage,severity:state.severity,findingQuery:state.findingQuery,findingStatus:state.findingStatus,indexExpanded:state.indexExpanded,reportToolsOpen:state.reportToolsOpen}:state.page==='tasks'?{attempt:state.attempt,taskOutputQuery:state.taskOutputQuery,eventType:state.eventType,follow:state.follow}:{})};
  }
  function restoreRecordView() {
    Object.assign(state,{tab:state.page==='reports'?'findings':state.page==='tasks'?'progress':'overview',finding:1,findingPage:1,severity:'all',findingQuery:'',findingStatus:'all',indexExpanded:false,reportToolsOpen:false,attempt:String(attemptCounts[state.id]||1),taskOutputQuery:'',eventType:'all',follow:true},state.recordViews[state.page+':'+state.id]||{});
  }
  const opsViewKeys={comments:['commentSearch','commentKind','commentStatus','commentNumber','commentTask','commentType','commentMore'],webhooks:['webhookSearch','webhookState','webhookKind','webhookNumber','webhookMode'],workers:['workerSearch','workerContact','workerCleanup'],repositories:['repoSearch','replyTemplate'],accounts:['accountSearch','accountState']};
  function publicOpsView(page,view={}) {return Object.fromEntries((opsViewKeys[page]||[]).filter(key=>Object.hasOwn(view,key)&&['string','number','boolean'].includes(typeof view[key])).map(key=>[key,textParam(String(view[key]))]));}
  function viewParams() {
    const p=new URLSearchParams({page:state.page});if(state.id)p.set('id',state.id);if(state.repo!=='all')p.set('repo',state.repo);
    if(state.id&&state.tab!=='overview')p.set('tab',state.tab);
    if(!state.id&&corePages.includes(state.page)){const f=currentList();for(const key of ['q','status','source','type','delivery'])if(f[key]&&f[key]!=='all')p.set(key,textParam(f[key]));if(f.page>1)p.set('lp',String(f.page));}
    if(state.id&&state.page==='reports'){if(state.finding>1)p.set('finding',String(state.finding));if(state.severity!=='all')p.set('severity',state.severity);if(state.findingQuery)p.set('fq',textParam(state.findingQuery));if(state.findingStatus!=='all')p.set('assessment',state.findingStatus);if(state.findingPage>1)p.set('fp',String(state.findingPage));}
    if(state.id&&state.page==='tasks'&&hasRecord('tasks',state.id)&&!state.followupTasks?.[state.id]){p.set('attempt',state.attempt);if(state.taskOutputQuery)p.set('oq',textParam(state.taskOutputQuery));if(state.eventType!=='all')p.set('event',state.eventType);}
    if(!corePages.includes(state.page))for(const [key,value]of Object.entries(publicOpsView(state.page,ops.getView?.(state.page))))if(value)p.set('o_'+key,value);
    return p;
  }
  function parseView(hash) {
    const p=new URLSearchParams(String(hash||'').replace(/^#/, '').slice(0,4096));
    const page=Object.hasOwn(names,p.get('page'))?p.get('page'):'pulls',rawId=p.get('id'),id=rawId&&/^[A-Za-z0-9_-]{1,64}$/.test(rawId)?rawId:null;
    const sections=page==='reports'?['findings','evidence','details']:page==='tasks'?['progress','evidence','details']:page==='repositories'?['overview','intake','replies','scheduling']:['overview','investigations','discussion'];
    const result={page,id,repo:enumParam(p.get('repo'),['all','fixture','fork'],'all'),tab:enumParam(p.get('tab'),sections,sections[0]),list:listDefaults(),view:{},ops:{}};
    if(!id&&corePages.includes(page)){result.list={...listDefaults(),q:textParam(p.get('q')),status:enumParam(p.get('status'),page==='reports'?['all','partial','complete']:page==='tasks'?['all','active','attention']:['all','Needs review','Running','Queued','Cancelling','Cancelled','Failed','Blocked','Interrupted','Completed'],'all'),source:enumParam(p.get('source'),['all','open','closed'],'all'),type:enumParam(p.get('type'),['all','pulls','Bug','Feature'],'all'),delivery:enumParam(p.get('delivery'),['all','Final','Checkpoint'],'all'),page:intParam(p.get('lp'))};}
    if(id&&page==='reports')result.view={finding:intParam(p.get('finding')),findingPage:intParam(p.get('fp')),severity:enumParam(p.get('severity'),['all','P0','P1','P2','P3'],'all'),findingQuery:textParam(p.get('fq')),findingStatus:enumParam(p.get('assessment'),['all','Confirmed','Needs verification','Needs decision'],'all')};
    if(id&&page==='tasks')result.view={attempt:String(intParam(p.get('attempt'),attemptCounts[id]||1,attemptCounts[id]||1)),taskOutputQuery:textParam(p.get('oq')),eventType:enumParam(p.get('event'),['all','agent','tool','event'],'all')};
    for(const key of opsViewKeys[page]||[])if(p.has('o_'+key))result.ops[key]=textParam(p.get('o_'+key));
    return result;
  }
  function applyView(route,{queue=null,scroll=0,opener=null}={}) {
    dialogSourceId=null;
    dialogOrigin=null;
    saveRecordView();state.page=route.page;state.id=route.id;state.repo=route.repo;state.queue=queue?.repo===route.repo&&queue.epoch===state.viewEpoch?queue:null;restoreRecordView();state.tab=route.tab;
    if(!route.id&&corePages.includes(route.page))state.lists[route.page]={...route.list,scroll,opener:listOpener(opener,route.page)};Object.assign(state,route.view);ops.applyView?.(route.page,route.ops);const intent=state.id?state.actionIntents[sourceKey()]:null;state.preview=ownsIntent(intent)?intent:null;
  }
  function routeSnapshot() {return {page:state.page,id:state.id,tab:state.tab,repo:state.repo,hash:'#'+viewParams().toString()};}
  function syncRoute(replace=false,scroll=window.scrollY) {
    if(!replace)routePosition++;
    const route=routeSnapshot();try {history[replace?'replaceState':'pushState']({ar:route,arQueue:state.queue?JSON.parse(JSON.stringify(state.queue)):null,arScroll:Math.max(0,Math.min(10000000,Number(scroll)||0)),arOpener:!state.id&&corePages.includes(state.page)?listOpener(currentList().opener):null,arViewEpoch:state.viewEpoch,arPosition:routePosition},'',route.hash);}catch{}
  }
  function viewChanged() {saveRecordView();syncRoute(true);}
  function setSection(tab) {state.tab=tab;syncRoute();render();}
  const relatedSourceId=id=>state.followupTasks?.[String(id)]?.sourceId||String(id);
  function nav(page,id=null,options={}) {
    guardNavigation(()=>{
      const candidateOrigin=options.rowOrigin||dialogOrigin;
      const origin=candidateOrigin&&!state.id&&candidateOrigin.page===state.page&&candidateOrigin.repo===state.repo&&relatedSourceId(id)===candidateOrigin.sourceId?candidateOrigin:null;
      dialogSourceId=null;
      dialogOrigin=null;
      const previousPage=state.page,previousId=state.id;saveRecordView();if(!previousId){currentList().scroll=window.scrollY;if(options.captureQueue)currentList().opener=listOpener(options.opener,previousPage);}syncRoute(true);
      if(origin)state.queue={origin:origin.page,originMemberId:origin.sourceId,repo:origin.repo,epoch:state.viewEpoch,ids:origin.ids,filter:origin.filter,scroll:origin.scroll,opener:listOpener(origin.opener,origin.page)};
      else if(options.captureQueue&&!previousId&&corePages.includes(previousPage)){const f=currentList();state.queue={origin:previousPage,originMemberId:String(id),repo:state.repo,epoch:state.viewEpoch,ids:matchedSources(previousPage,f).map(x=>x.id),filter:{...f},scroll:window.scrollY,opener:listOpener(f.opener,previousPage)};}
      else if(options.queueItem&&state.queue)state.queue.originMemberId=String(id);
      else if(!(id&&previousId&&relatedSourceId(id)===relatedSourceId(previousId)&&corePages.includes(page)))state.queue=null;
      const scroll=options.scroll??(!id&&page===previousPage&&previousId?state.lists[page]?.scroll||0:0);
      state.history.push(routeSnapshot());state.page=names[page]?page:'pulls';state.id=id?String(id):null;state.q='';restoreRecordView();const intent=state.id?state.actionIntents[sourceKey()]:null;state.preview=ownsIntent(intent)?intent:null;
      if($('ar-dialog').open)closeDialog();clearToast();const restoreList=!state.id&&corePages.includes(state.page),opener=restoreList?listOpener(options.opener||currentList().opener):null;syncRoute();render({deferFocus:restoreList});restoreScroll(scroll,{restoreList,opener});
    });
  }
  function workerEvent(event) {
    const id=String(event.taskId||'').replace(/^task-/,''),x=fixtures.find(record=>record.id===id),worker=state.ops.workers?.find(w=>w.id===event.workerId);
    if(!x||!worker||String(worker.owner||'').replace(/^task-/,'')!==id||x.mode!=='E2E')return;
    if(event.type==='admission-disabled'&&['Running','Queued'].includes(x.status))x.status='Cancelling';
    if(event.type==='cleanup-acknowledged'&&x.status==='Cancelling')x.status='Cancelled';
  }
  const ops=createOperations({root,state,h,render,nav,openDialog,closeDialog,toast,markDirty,clearDirty,clearPrivateSession,guardNavigation,fresh,download,setSection,viewChanged,workerEvent,hasRecord});
  const followups=createFollowupTasks({state,h:{...h,dt:values=>dt(values)},source:id=>fixtures.find(x=>x.id===id)});
  const publication=createPublicationWorkbench({root,state,h:{...h,select,dt:values=>dt(values)},item,findings:x=>reportSnapshots[x.id]?findingsFor(reportSnapshots[x.id]):[],feedbackFor:f=>state.drafts[item().id+':'+f.id]??draftBaseline(item().id+':'+f.id),sourceKey,currentAccount,can,prepareReason:prepareOperationReason,canExecute,fresh,pendingIntent,ownsIntent,openDialog,closeDialog,render,toast,dialogError,originalCommit,legacySha:()=>actionDraft().sha,setLegacySha:value=>{actionDraft().sha=value;},assessment:()=>assessmentFor(item()),createFollowup:intent=>followups.create(intent),activeFollowup:()=>followups.forSource(item().id).find(task=>['Queued','Running'].includes(task.status))});
  function recommendation(x=item()) {
    const saved=reportSnapshots[x.id],decision=assessmentFor(x),live=fixtures.find(record=>record.id===x.id)||x,pending=pendingIntent(x),followup=followups.forSource(x.id).find(task=>['Queued','Running'].includes(task.status)),lastSubmission=publication.lastReceipt(x);
    let next=decision.next,action=decision.action,reason=decision.reason,blocked='';
    if(pending){next=ownsIntent(pending)?'Check saved submission':'Submission pending';action=ownsIntent(pending)?'receipt':'waiting';reason='Resolve the existing submission before preparing another action.';blocked=ownsIntent(pending)?'':'Only the account that created this submission can check its receipt.';}
    else if(followup){next='Open follow-up task';action='followup-task';reason='The saved plan is queued in a separate Task. No new verification result is available yet.';}
    else if(publication.sourceState(x)!=='Open'){next=x.kind==='Feature'?'View saved plan':'View saved evidence';action='saved-evidence';reason='This source is '+publication.sourceState(x).toLowerCase()+'. Its saved assessment and evidence remain available.';}
    else if(lastSubmission&&['request-changes','approve','suggestion','comment'].includes(lastSubmission.operation)){next='View last submission';action='last-submission';reason='Your feedback for this saved revision was recorded. The saved assessment remains unchanged.';}
    else if((!saved||saved.completeness==='Partial')&&['Running','Queued','Cancelling'].includes(live.status)){next=live.status==='Cancelling'?'Check cleanup status':'Follow latest attempt';action='progress';reason=live.status==='Cancelling'?'Wait for the original Worker to confirm cleanup before resuming.':'Follow the current task. This saved assessment remains unchanged until a new report is produced.';}
    else if(saved?.completeness==='Partial'&&live.status==='Cancelled'){next='Review resume budget';action='resume';reason='Execution has stopped. Review the retained checkpoint and limits before resuming.';}
    if(['request-changes','clarify','verification'].includes(action))blocked=publication.sourceBlock(x)||prepareOperationReason({clarify:'comment',verification:'followup'}[action]||action,x)||(!fresh()?'Refresh current action guards before preparing.':state.scenario==='stale'?'Source changed. Review a fresh source snapshot before preparing this recommendation.':'');
    if(action==='resume')blocked=!can('task:create')?'Resuming requires task:create for this repository.':live.mode==='E2E'&&!currentAccount()?.execution?'E2E resume requires a repository execution grant.':!fresh()?'Refresh current task guards before resuming.':'';
    if(action==='start')blocked=!can('task:create')?'Starting requires task:create for this repository.':!fresh()?'Refresh current task guards before starting.':'';
    return {next,action,reason,blocked};
  }
  function outcomeSummary(x=item()) {
    const saved=reportSnapshots[x.id],decision=assessmentFor(x),next=recommendation(x),partial=saved?.completeness==='Partial';
    const label=!saved?'Investigation':partial?'Checkpoint · Not final':x.type==='issues'?'Triage':'Review conclusion';
    const detailLink=state.page!=='reports'?button('Read report','open:reports:'+x.id,'ghost small'):next.action==='saved-evidence'?'':button(x.type==='issues'?'View saved plan':'View evidence',x.type==='issues'?'followup-plan':'outcome-evidence','ghost small');
    const secondary=saved?detailLink+button('Other actions','prepare','ghost small',!can('action:prepare')||!fresh()?'disabled':''):'';
    return `<section class="ar-outcome-summary" aria-labelledby="ar-outcome-title"><div class="ar-outcome-decision"><p class="ar-kicker">${label}</p><h2 id="ar-outcome-title">${esc(decision.label)}</h2><p class="ar-outcome-validation">${icon(partial?'circle-help':x.type==='issues'?'clipboard-check':'git-pull-request')}<strong>${esc(decision.validation)}</strong></p><details><summary>Assessment details</summary><p>${esc(decision.rationale)}</p><p>${esc(next.reason)}</p><span class="ar-small ar-muted">${saved?'Report v1 · '+saved.completeness+' · '+saved.delivery:'No saved report'}${state.scenario==='stale'?' · Older revision':''}</span></details></div><div class="ar-outcome-action"><div class="ar-row">${button(esc(next.next),'recommended','primary',next.blocked?'disabled aria-describedby="ar-outcome-blocked"':'')}${secondary}</div>${next.blocked?`<p id="ar-outcome-blocked" class="ar-small ar-muted">${esc(next.blocked)}</p>`:''}</div></section>`;
  }
  function openOutcomeEvidence() {
    const x=item(),section=x.kind==='Feature'?'details':'evidence';
    if(state.page==='reports'&&state.id===x.id){setSection(section);return;}
    guardNavigation(()=>{nav('reports',x.id);setSection(section);});
  }
  function runRecommendation() {
    const x=item(),next=recommendation(x);if(next.blocked){toast(next.blocked);return;}
    if(next.action==='receipt'){unknownActionDialog(pendingIntent());return;}
    if(next.action==='last-submission'){publication.receipt(publication.lastReceipt());return;}
    if(next.action==='followup-task'){const task=followups.latestForSource(item().id);if(task)nav('tasks',task.id);return;}
    if(next.action==='saved-evidence'){openOutcomeEvidence();return;}
    if(next.action==='resume'){handle('resume');return;}
    if(next.action==='start'){handle('start');return;}
    if(['progress','prerequisites'].includes(next.action)){
      const section=next.action==='prerequisites'?'details':'progress';
      guardNavigation(()=>{if(state.page!=='tasks'||state.id!==x.id)nav('tasks',x.id);state.attempt=String(attemptCounts[x.id]||1);setSection(section);});return;
    }
    if(next.action==='verification'){handle('followup-plan');return;}
    if(['request-changes','clarify'].includes(next.action))publication.open(next.action==='clarify'?'comment':'request-changes',next.action==='clarify'?{seed:'Please confirm the selective-export rules before implementation: should dependent settings be included automatically or block export? How should omitted settings, defaults and existing import formats be handled?'}:{});
  }
  function openRowAction(page,id,opener) {
    const source=fixtures.find(record=>record.id===id&&record.type===page);
    if(!source||!canReadSource()||state.repo==='fork')return;
    const next=recommendation(source);
    if(next.blocked){toast(next.blocked);return;}
    guardNavigation(()=>{
      dialogSourceId=source.id;
      dialogOrigin={page,sourceId:source.id,repo:state.repo,filter:{...currentList()},ids:matchedSources(page,currentList()).map(record=>record.id),scroll:window.scrollY,opener:focusKey(opener)};
      const intent=state.actionIntents[sourceKey(source)];
      state.preview=ownsIntent(intent)?intent:null;
      runRecommendation();
      if($('ar-dialog').open){lastFocus=opener;lastFocusKey=focusKey(opener);}
      else {dialogSourceId=null;dialogOrigin=null;}
    });
  }
  function queueBar() {
    const q=state.queue,index=q?.repo===state.repo?q.ids.indexOf(q.originMemberId||state.id):-1;
    if(index<0)return `<div class="ar-back">${button(icon('arrow-left')+' Back to '+names[state.page].toLowerCase(),'back','ghost small')}</div>`;
    const label='Back to '+names[q.origin].toLowerCase()+' results';
    return `<nav class="ar-review-queue" aria-label="Review result queue">${button(icon('arrow-left')+'<span class="ar-queue-long">'+label+'</span><span class="ar-queue-short">Results</span>','back','ghost small','aria-label="'+label+'"')}<span class="ar-small ar-muted">${q.origin==='pulls'?'PRs':names[q.origin]} · ${index+1}/${q.ids.length}</span><div class="ar-row">${button(icon('arrow-left'),'queue:prev','small','aria-label="Previous result" '+(index===0?'disabled':''))}${button(icon('arrow-right'),'queue:next','small','aria-label="Next result" '+(index===q.ids.length-1?'disabled':''))}</div></nav>`;
  }
  function back() {const q=state.queue;if(q&&q.repo===state.repo&&q.ids.includes(q.originMemberId||state.id)){guardNavigation(()=>{state.lists[q.origin]={...q.filter,opener:q.opener};nav(q.origin,null,{scroll:q.scroll,opener:q.opener});});}else nav(state.page);}
  const copyViewLabel=()=>['http:','https:'].includes(location.protocol)?'Copy view link':'Copy view state';
  async function copyView() {
    const hash='#'+viewParams().toString(),link=['http:','https:'].includes(location.protocol)?location.origin+location.pathname+hash:hash;
    try {if(!globalThis.navigator?.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(link);toast('View copied · No private drafts included.');}
    catch {openDialog('Copy current view',notice(['http:','https:'].includes(location.protocol)?'Copy this view link manually.':'Append this view state to this prototype address. Private drafts are excluded.')+field('Public view '+(link.startsWith('#')?'state':'link'),'ar-copy-view-value',link,'text','readonly'),button('Done','dialog-close','primary'));$('ar-copy-view-value')?.select();}
  }
  function sourceFilters() {
    const f=currentList(),filtered=f.status!=='all'||f.source!=='all'||f.q; return `<div class="ar-toolbar ar-source-toolbar"><div class="ar-search">${field('Search '+names[state.page].toLowerCase(),'ar-list-search',f.q,'search','placeholder="Title or source number"')}</div>${select('Source state','ar-source-state',[['all','All source states'],['open','Open'],['closed','Closed']],f.source)}${button('Filters','filters','small')}${filtered?button('Clear filters','clear-filters','ghost small'):''}${button(icon('refresh-cw')+'<span class="ar-refresh-label">Refresh</span>','refresh','ghost small','aria-label="Refresh sources"')}</div><div class="ar-mobile-filter-summary"><span>${esc(f.status==='all'?'All investigations':f.status)} · ${esc(f.source==='all'?'All source states':f.source==='open'?'Open sources':'Closed sources')}</span></div><div class="ar-pills ar-source-pills">${[...new Set(['all','Needs review','Running','Blocked','Interrupted','Completed',f.status])].map(s=>`<button type="button" data-action="filter:${s}" aria-pressed="${f.status===s}">${s==='all'?'All investigations':s}</button>`).join('')}</div>`;
  }
  function sourceRow(x,page=state.page) {
    if(page==='tasks'&&x.sourceId)return followups.row(x);
    const summary=page==='reports'?{validation:x.validation}:taskSummary(x),decision=assessmentFor(x);
    if(['pulls','issues'].includes(page)){
      const next=recommendation(x),label=({ 'request-changes':'Request changes',clarify:'Comment',verification:'Verify issue',resume:'Resume review',start:x.type==='issues'?'Investigate issue':'Start review',progress:'View progress',prerequisites:'View prerequisites',receipt:'Check submission','last-submission':'View receipt','followup-task':'Open follow-up','saved-evidence':x.kind==='Feature'?'View saved plan':'View evidence',waiting:'Submission pending' })[next.action]||next.next;
      const subject=(x.type==='issues'?'Issue':'PR')+' #'+x.id,action='recommended:'+page+':'+x.id;
      return `<div class="ar-source-row ar-source-actions" role="group" aria-label="${esc(subject)}"><button type="button" id="ar-source-${esc(page)}-${esc(x.id)}" class="ar-source-open" data-action="open:${page}:${x.id}"><span class="ar-source-main"><strong class="ar-source-title">${esc(x.title)}</strong><span class="ar-source-meta">${subject} · ${x.kind||x.mode+' review'} · ${esc(publication.sourceState(x))} · ${esc(x.status)}</span></span></button><span class="ar-state ar-row-action-cell">${button(esc(label),action,'tonal small ar-row-action',`id="ar-row-action-${esc(page)}-${esc(x.id)}" aria-label="${esc(label+' for '+subject+(next.blocked?'. '+next.blocked:''))}" ${next.blocked?'disabled':''}`)}</span>${design.validation?`<span class="ar-validation ar-state" role="group" aria-label="${esc((x.kind==='Bug'?'Reproduction':'Validation')+': '+summary.validation)}">${badge(summary.validation,tone(summary.validation))}</span>`:'<span class="ar-validation"></span>'}<button type="button" class="ar-source-chevron ar-icon-button" data-action="open:${page}:${x.id}" aria-label="Open ${esc(subject)} details">${icon('chevron-right')}</button></div>`;
    }
    return `<button type="button" id="ar-source-${esc(page)}-${esc(x.id)}" class="ar-source-row" data-action="open:${page}:${x.id}"><span class="ar-source-main"><strong class="ar-source-title">${esc(x.title)}</strong><span class="ar-source-meta">${x.type==='issues'?'Issue':'PR'} #${x.id} · ${x.kind || x.mode+' review'}${page==='reports'?' · '+x.completeness+' · '+x.delivery:page==='tasks'?'':' · '+publication.sourceState(x)+' · '+x.status}</span></span><span class="ar-state">${page==='tasks'?badge(x.status,tone(x.status)):`<strong>${esc(decision.label)}</strong>`}</span>${design.validation?`<span class="ar-validation ar-state" role="group" aria-label="${x.kind==='Bug'?'Reproduction':'Validation'}: ${esc(summary.validation)}">${badge(summary.validation,tone(summary.validation))}</span>`:'<span class="ar-validation"></span>'}<span class="ar-chevron">${icon('chevron-right')}</span></button>`;
  }
  function sourceList() {
    const f=currentList(),found=matchedSources(),visible=listPage(found);
    const importReason=!can('repository:manage')?'Importing requires Manage repositories permission for this repository.':!fresh()?'Refresh the snapshot before importing a new source.':'';
    return heading(names[state.page],'',button(icon('plus')+' Import from GitHub','import','primary',importReason?'disabled aria-describedby="ar-import-reason"':''))+(importReason?`<p id="ar-import-reason" class="ar-small ar-muted">${importReason}</p>`:'')+sourceFilters()+(!found.length?empty('No matching sources','Try another search or clear the filters.',button('Clear filters','clear-filters')):`<div class="ar-list"><div class="ar-list-label"><span>${found.length} ${names[state.page].toLowerCase()}</span><span>Action · Validation</span></div>${visible.map(x=>sourceRow(x)).join('')}${listPager(found.length)}</div>`);
  }
  const facts = values => `<div class="ar-facts">${values.map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join('')}</div>`;
  const dt = values => `<dl class="ar-definition">${values.map(([l,v])=>`<dt>${l}</dt><dd>${v}</dd>`).join('')}</dl>`;
  function sourceDescription(x) {
    return {'2101':'Keep the previous configuration when settings migration is cancelled.','2102':'Review Command Palette keyboard navigation and its configuration changes.','2103':'Retain command search history when updating the application.','2201':'Verify Settings interactions against the saved source revision.','2202':'Check the pinned build prerequisites before launching the application.','2203':'Inspect the current E2E attempt and its pending capture.','3101':'Settings exits before its window becomes usable after an update. Reproduction is pending.','3102':'Export selected Settings sections while preserving dependency and import compatibility.'}[x.id]||'Imported source snapshot. An investigation has not started.';
  }
  function sourceDetail() {
    const x=item(), isIssue=x.type==='issues', active=['overview','investigations','discussion'].includes(state.tab)?state.tab:'overview';
    const startReason=publication.sourceState(x)!=='Open'?'The source is '+publication.sourceState(x).toLowerCase()+'.':!can('task:create')?'Starting an investigation requires Create investigations permission for this repository.':!fresh()?'Refresh the snapshot before starting an investigation.':'';
    let content='';
    if(active==='overview') content=`<div class="ar-split"><div class="ar-stack"><section class="ar-panel"><h2>${isIssue?'About this issue':'About this change'}</h2><p>${esc(sourceDescription(x))}</p><details><summary>Recorded source snapshot</summary>${dt([['Repository','example/dashboard-ui-fixture'],['Source',`${isIssue?'Issue':'PR'} #${x.id}`],['Revision','fixture-revision-01'],['Imported discussion','2 retained comments']])}${button('Inspect exact snapshot','snapshot','ghost small')}</details></section><section class="ar-panel"><div class="ar-row"><h2>${followups.forSource(x.id).length?'Original investigation':'Current investigation'}</h2><span class="ar-spacer"></span>${badge(x.status,tone(x.status))}</div><p class="ar-muted" style="margin-top:12px">${esc(taskSummary(x).savedResult)} · ${isIssue?'Imported issue snapshot':'Exact original PR revision'}</p><div class="ar-row" style="margin-top:16px">${hasRecord('tasks',x.id)?button('Open task','open:tasks:'+x.id):'<p class="ar-small ar-muted">No investigation task yet.</p>'}${reportSnapshots[x.id]?button('Read report '+icon('arrow-right'),'open:reports:'+x.id):''}</div></section></div><aside class="ar-panel"><h2>Source context</h2>${dt([['Repository','example/dashboard-ui-fixture'],['Source state',badge(publication.sourceState(x),publication.sourceState(x)==='Open'?'success':'neutral')],['Classification',isIssue?x.kind||'Unclassified':'Pull request'],['Saved source',isIssue?'Imported Issue snapshot':'a4d71e2 · commit']])}<hr>${button('View recorded discussion','source-tab:discussion','ghost small')}${button('Open source snapshot','snapshot','ghost small')}</aside></div>`;
    if(active==='investigations') content=`<div class="ar-list"><div class="ar-list-label">Investigation retained for this source</div>${x.status==='Needs review'?empty('No investigation created','Create an investigation from the saved source snapshot.'):sourceRow(x,'tasks')}${followups.forSource(x.id).map(task=>followups.row(task)).join('')}</div>`;
    if(active==='discussion') content=`${notice('Imported discussion · 21 Sep, 09:10')}<div class="ar-stack"><section class="ar-panel"><div class="ar-row"><h3>Fixture maintainer</h3><span class="ar-muted ar-small">21 Sep, 09:02 · Imported</span></div><p>${isIssue?(x.kind==='Feature'?'Please clarify dependency and import compatibility rules.':'Please verify the update and Settings launch steps.'):'Please review the saved revision and record required validation.'}</p></section><section class="ar-panel"><h3>Fixture author</h3><p>${isIssue&&x.kind==='Feature'?'The compatibility decisions remain open.':'Runtime validation has not been recorded.'}</p></section></div>`;
    return queueBar()+`<div class="ar-kicker">${isIssue?'Issue':'Pull request'} #${x.id} · example/dashboard-ui-fixture</div>`+heading(x.title,publication.sourceState(x)+' · Snapshot imported 21 Sep, 09:10',githubLink(x)+(reportSnapshots[x.id]?button(isIssue?'New investigation':'New review','start','',startReason?'disabled aria-describedby="ar-start-reason"':''):''))+(startReason?`<p id="ar-start-reason" class="ar-small ar-muted">${startReason}</p>`:'')+(state.scenario==='stale'?notice('The source context is outdated. '+button('Refresh source context','refresh','small'),'warning'):'')+outcomeSummary(x)+tabs([{id:'overview',label:'Overview'},{id:'investigations',label:'Investigations'},{id:'discussion',label:'Discussion'}],active,'source-tab:')+content;
  }
  function taskList() {
    const f=currentList(),found=matchedSources(),visible=listPage(found);
    return heading('Tasks','',button('Choose a source','page:pulls','primary'))+`<div class="ar-toolbar"><div class="ar-search">${field('Search tasks','ar-list-search',f.q,'search','placeholder="Title or source number"')}</div>${f.q||f.status!=='all'?button('Clear filters','clear-filters','ghost small'):''}${button(icon('refresh-cw')+' Refresh','refresh','ghost')}</div><div class="ar-pills">${[['all','All tasks'],['active','Active'],['attention','Needs attention']].map(([v,l])=>`<button data-action="filter:${v}" type="button" aria-pressed="${f.status===v}">${l}</button>`).join('')}</div>`+(!found.length?empty('No matching tasks','Try another search or clear the filters.',button('Clear filters','clear-filters')):`<div class="ar-list"><div class="ar-list-label"><span>${found.length} tasks</span><span>Status · Validation</span></div>${visible.map(x=>sourceRow(x,'tasks')).join('')}${listPager(found.length)}</div>`);
  }
  function evidence() {
    if(item().type==='issues')return `<section class="ar-panel"><h2>${item().kind==='Feature'?'Acceptance criteria':'Reproduction evidence'}</h2>${notice(item().kind==='Feature'?'The saved request describes desired behavior. Maintainer acceptance, implementation and runtime checks are not recorded.':'The imported reporter statement describes the startup failure. No accepted runtime observation confirms reproduction.','warning')}${dt([['Subject','Imported Issue snapshot'],['Evidence','Retained description and discussion'],['Runtime result','Not recorded']])}</section>`;
    return `<div class="ar-grid"><section class="ar-panel"><h2>Validation checks</h2><div class="ar-row">${badge('Required E2E','warning')}${badge('Not run','neutral')}</div><details><summary>Required check and subject</summary>${dt([['Check','Cancel settings migration'],['Expected','Prior settings remain unchanged'],['Subject','Original PR revision a4d71e2'],['Recorded result','No accepted runtime result']])}</details></section><section class="ar-panel"><h2>Registered evidence</h2><div class="ar-media"><span class="ar-muted">settings-cancellation.png</span>${badge('Unavailable','warning')}<span class="ar-small ar-muted">File not retained.</span>${button('View provenance','artifact','small')}</div></section></div>`;
  }
  const attemptCounts={'2103':2};
  function outputEntries(x=item()) {
    const entry=(time,type,title,text)=>({time,type,title,text});
    let entries;
    if(x.status==='Queued'&&Number(state.attempt)===(attemptCounts[x.id]||1))entries=[entry('09:35:00','event','Attempt queued','Frozen source and reviewed budget retained. No Worker has started this synthetic attempt.')];
    else if(x.id==='2103'&&state.attempt==='1')entries=[entry('09:00:01','event','Initial attempt started','Pinned the original PR source and located command-history persistence.'),entry('09:02:14','tool','Retained source read','Loaded history serialization and migration call sites.'),entry('09:04:20','event','Checkpoint v3 saved','Initial source map retained. This attempt ended before the follow-up candidate recheck.')];
    else if(x.id==='2103')entries=[entry('09:10:01','event','Resumed attempt started','Restored checkpoint v3 with the same frozen source and prompt.'),entry('09:12:09','agent','Candidate recheck','Compared the history write path with the saved migration boundaries.'),entry('09:14:20','event','Token limit reached','Task total reached 20,000 tokens. Checkpoint v4 retained; execution stopped. Runtime checks remain unrecorded.')];
    else if(x.status==='Blocked')entries=[entry('09:10:01','event','E2E preflight started','Checked Worker admission and pinned execution prerequisites.'),entry('09:10:04','tool','Required toolchain unavailable','The assigned Worker could not locate the pinned build prerequisite.'),entry('09:10:05','event','Attempt blocked','No application was launched. Repair the prerequisite before resuming the saved plan.')];
    else if(x.mode==='E2E')entries=[entry('09:10:01','event','E2E ownership acquired','The assigned Worker owns this attempt and its cleanup lifecycle.'),entry('09:10:04','tool','Capture session opened','An in-progress synthetic capture is registered; no accepted validation result is available.'),entry(x.status==='Cancelled'?'Just now':'09:11:12','event',x.status==='Cancelled'?'Cleanup acknowledged':x.status==='Cancelling'?'Cleanup requested':'Waiting for observation',x.status==='Cancelled'?'The original Worker acknowledged cleanup. Execution stopped without an accepted validation result.':x.status==='Cancelling'?'Ownership remains with the Worker until cleanup is confirmed.':'The sample task is in progress. A started capture does not establish a passed check.')];
    else if(x.type==='issues')entries=[entry('09:10:01','event','Issue snapshot loaded','Loaded the imported description and retained discussion.'),entry('09:10:04','agent',x.kind==='Feature'?'Acceptance plan recorded':'Reported trigger recorded',x.kind==='Feature'?'Selective export needs explicit compatibility and dependency decisions.':'Retained the reporter’s Settings startup steps without claiming runtime reproduction.'),entry('09:14:20','event','Saved assessment',x.kind==='Feature'?'Implementation plan saved. Maintainer acceptance remains separate.':'Assessment saved as needs verification. Exact-source follow-up is still pending.')];
    else entries=[entry('09:10:01','event','Source review started','Pinned the original PR revision and loaded the retained source.'),entry('09:10:04','tool','Changed paths inspected','Read the changed paths and matched candidates to the original snapshot.'),entry('09:12:09','agent','Final recheck recorded',x.id==='2102'?'The complete synthetic report contains 26 findings, including the unresolved P0 at finding 26.':'Two source findings were retained after final recheck.'),entry('09:14:20','event','Report saved','Source review completed. Required E2E validation has no accepted result.')];
    return entries.filter(e=>(state.eventType==='all'||state.eventType===e.type)&&(e.text+' '+e.title).toLowerCase().includes(state.taskOutputQuery.toLowerCase()));
  }
  function noTaskView() {
    const x=item(),reason=!can('task:create')?'Creating this task requires Create investigations permission for this repository.':!fresh()?'Refresh the source snapshot before creating an investigation.':'';
    return queueBar()+heading('No investigation task yet',esc(x.title),githubLink(x))+empty('Ready for an investigation','This source has no task, attempts or execution output. Create an investigation to follow its progress.',button('Open source','open:'+x.type+':'+x.id)+button('Create investigation','start','primary',reason?'disabled aria-describedby="ar-no-task-reason"':''))+(reason?`<p id="ar-no-task-reason" class="ar-small ar-muted">${reason}</p>`:'');
  }
  function taskDetail() {
    const followup=followups.find(state.id);if(followup)return queueBar()+followups.detail(followup).replace(/^<div class="ar-back">[\s\S]*?<\/div>/,'');
    const x=item(), active=['progress','evidence','details'].includes(state.tab)?state.tab:'progress';
    if(!hasRecord('tasks',x.id))return noTaskView();
    const activeTask=['Running','Queued'].includes(x.status),recoverableTask=['Interrupted','Blocked','Failed','Cancelled'].includes(x.status);
    const cancelReason=!can('task:cancel')?'Cancelling this task requires Cancel investigations permission for this repository.':!fresh()?'Refresh the snapshot before requesting task cancellation.':'';
    const resumeReason=!can('task:create')?'Resuming this task requires Create investigations permission for this repository.':x.mode==='E2E'&&!currentAccount()?.execution?'Resuming an E2E task requires a repository execution grant.':!fresh()?'Refresh the snapshot before resuming this task.':'';
    const actionReason=activeTask?cancelReason:recoverableTask?resumeReason:x.status==='Cancelling'?'Cancellation is requested. Resume remains unavailable until the original Worker confirms cleanup.':'';
    const taskAction=activeTask?button('Cancel task','cancel-task','',cancelReason?'disabled aria-describedby="ar-task-action-reason"':''):recoverableTask?button('Resume checkpoint','resume','primary',resumeReason?'disabled aria-describedby="ar-task-action-reason"':''):'';
    let content='';
    if(active==='progress') {
      const entries=outputEntries(x);
      const budget=taskBudget(x),consumed=taskConsumption(x),latest=String(attemptCounts[x.id]||1),historical=state.attempt!==latest;
      const nextStep=x.status==='Blocked'?'Repair the pinned toolchain, then check prerequisites.':x.status==='Interrupted'?'Increase the token limit to resume the saved checkpoint.':x.status==='Cancelling'?'Waiting for the owner Worker to confirm cleanup.':x.status==='Queued'?'Waiting for Worker admission.':x.status==='Cancelled'?'Execution stopped. The saved checkpoint can be resumed.':'No accepted validation result yet.';
      const progress=x.status==='Completed'?'':`<section class="ar-task-progress ar-panel"><div class="ar-row"><h2>${x.status==='Interrupted'?'Token budget exhausted':x.status==='Blocked'?'Build prerequisite blocked':x.status==='Cancelling'?'Cleanup pending':esc(x.status)}</h2></div>${x.status==='Interrupted'?`<p><strong>${consumed.tokens.toLocaleString()} / ${budget.tokens.toLocaleString()} tokens</strong></p>`:''}<p>${nextStep}</p>${x.mode==='E2E'?`<div class="ar-row"><span class="ar-small ar-muted">${ownerWorker(x)?'Owner: '+esc(ownerWorker(x).id):x.status==='Cancelled'?'No active owner · cleanup acknowledged':'Owner not recorded'}</span>${ownerWorker(x)&&permitted('workers')?button('Inspect Worker','open:workers:'+ownerWorker(x).id,'ghost small'):''}</div>`:''}</section>`;
      content=progress+`<section class="ar-panel"><div class="ar-row"><h2>Agent output</h2>${badge(historical?'Historical attempt':'Saved output')}<span class="ar-spacer"></span>${button('Latest entry','output-latest','small',entries.length?'':'disabled')}${button('Export loaded output','output-export','small')}</div><div class="ar-toolbar">${select('Attempt','ar-attempt',Array.from({length:attemptCounts[x.id]||1},(_,i)=>[String(i+1),'Attempt '+(i+1)+(i===(attemptCounts[x.id]||1)-1?' · latest':' · historical')]),state.attempt)}${button('Latest attempt','latest-attempt','small',historical?'':'disabled')}<div class="ar-search">${field('Search loaded output','ar-output-search',state.taskOutputQuery,'search','maxlength="160"')}</div>${select('Event type','ar-event-type',[['all','All events'],['agent','Agent'],['tool','Tool results'],['event','Task events']],state.eventType)}${state.taskOutputQuery||state.eventType!=='all'?button('Clear filters','clear-output-filters','ghost small'):''}</div>${historical?notice('Attempt '+state.attempt+' · Historical output. Task status shows the latest attempt.') : ''}<details class="ar-task-usage"><summary>Model & usage</summary>${facts([['Reported tokens',x.tokens===null?'Not reported':x.tokens.toLocaleString()],['Requested model','synthetic-codex-model'],['Reasoning effort','Not recorded'],['Usage completeness',x.tokens===null?'Not available':'Reported counters']])}</details>${entries.length?entries.map(e=>`<div class="ar-log"><span class="ar-small ar-muted">${e.time}</span><div><h3>${e.title}</h3><p>${e.text}</p></div></div>`).join(''):empty('No matching output','Try another term or clear the filters.',button('Clear output filters','clear-output-filters'))}</section>`;
    }
    if(active==='evidence') content=evidence();
    if(active==='details') content=`<div class="ar-grid"><section class="ar-panel"><h2>Frozen inputs</h2>${dt([['Task','task-'+x.id],['Mode',x.mode],['Source','fixture-revision-01'],['Profile','Source review'],['Prompt','Saved investigation prompt'],['Budget',taskBudget(x).rounds+' rounds · '+taskBudget(x).minutes+' minutes · '+taskBudget(x).tokens.toLocaleString()+' tokens · '+taskBudget(x).report+' MiB']])}</section><section class="ar-panel"><h2>Ownership & recovery</h2>${dt([['Worker',ownerWorker(x)?esc(ownerWorker(x).id):'No active owner recorded'],['Checkpoint',x.status==='Interrupted'?'v4 · token limit reached':'v2 · retained'],['Cleanup',x.status==='Cancelling'?'Awaiting original-owner confirmation':x.status==='Running'?'Execution owned':'Confirmed / no active execution'],['Linked work','Saved validation plan']])}<hr>${button('Open source','open:'+x.type+':'+x.id,'ghost small')}${reportSnapshots[x.id]?button('Open report','open:reports:'+x.id,'ghost small'):''}</section></div>`;
    return queueBar()+`<div class="ar-kicker">${x.mode} investigation · ${x.type==='issues'?'Issue':'PR'} #${x.id}</div>`+heading(x.title,'task-'+x.id+' · Exact saved source',githubLink(x)+(reportSnapshots[x.id]?button('Read report','open:reports:'+x.id,x.status==='Completed'?'primary':''):'')+taskAction)+(actionReason?`<p id="ar-task-action-reason" class="ar-small ar-muted">${actionReason}</p>`:'')+facts([['Execution',badge(x.status,tone(x.status))],['Validation',taskSummary(x).validation],['Mode',x.mode],['Saved assessment',reportSnapshots[x.id]?assessmentFor(x).label:'No report']])+tabs([{id:'progress',label:'Progress'},{id:'evidence',label:'Evidence'},{id:'details',label:'Details'}],active,'task-tab:')+content;
  }
  function findingsFor(x) {
    if(x.type==='issues')return [{id:1,priority:'P1',status:x.kind==='Feature'?'Needs decision':'Needs verification',title:x.kind==='Feature'?'Selective export needs an explicit compatibility decision':'Settings startup exits after updating',path:x.kind==='Feature'?'Imported feature request · acceptance criteria':'Imported issue description · steps 1–3',subject:'Issue snapshot',trigger:x.kind==='Feature'?'Selecting only some settings for export needs rules for dependencies, default values and import compatibility. Maintainer decisions remain pending.':'The reporter describes Settings exiting before its window becomes usable after an update. This is a retained report; runtime reproduction is still pending.',excerpt:x.kind==='Feature'?'Request: export selected Settings sections while preserving existing defaults.':'Reported steps: update the application, open Settings, observe the window exiting.',recheck:x.kind==='Feature'?'Requirements were reviewed against the imported request. Maintainer acceptance and implementation have not been recorded.':'The reporter statement is retained. Runtime reproduction and root cause have not been confirmed.',feedback:x.kind==='Feature'?'Please confirm compatibility and dependency rules before implementing selective export.':'Please verify the reported startup failure against an exact source commit and retain the observed result.'}];
    const count=x.id==='2102'?26:x.type==='issues'?1:2;
    return Array.from({length:count},(_,i)=>({id:i+1,priority:x.id==='2102'&&i===25?'P0':'P1',status:i===3?'Needs verification':'Confirmed',title:i===25?'Unconditional deletion can remove the persisted configuration':count>2?`Cancellation path ${i+1} can persist stale settings`:i===0?'Cancellation can persist stale settings':'Cancelled migration can leave an incomplete configuration',path:i===25?'ConfigurationStore.cs:126':`SettingsMigration.cs:${42+i*3}`,subject:'original PR revision',trigger:i===25?'Deleting the store before validating the destination can remove all saved settings when the destination is inaccessible.':'Cancel a settings migration after processing begins. The final write may still overwrite the last saved configuration.',excerpt:'if (cancellationRequested) return;\nawait configuration.SaveAsync(nextSettings);',recheck:i===3?'The candidate still needs verification. Neither a final confirmation nor runtime validation is recorded.':'Confirmed against the retained source. No accepted runtime validation is recorded.',feedback:'Please preserve the previously saved settings when cancellation is requested. The write must be guarded before persistence.'}));
  }
  function reportList() {
    const f=currentList(),found=matchedSources(),visible=listPage(found);
    return heading('Reports')+`<div class="ar-toolbar"><div class="ar-search">${field('Search reports','ar-list-search',f.q,'search')}</div>${select('Type','ar-report-type',[['all','All types'],['pulls','PR review'],['Bug','Bug investigation'],['Feature','Feature plan']],f.type)}${select('Completeness','ar-report-completeness',[['all','All reports'],['complete','Complete'],['partial','Partial']],f.status)}${select('Delivery','ar-report-delivery',[['all','All delivery types'],['Final','Final'],['Checkpoint','Checkpoint']],f.delivery)}${f.q||f.type!=='all'||f.status!=='all'||f.delivery!=='all'?button('Clear filters','clear-filters','ghost small'):''}${button(icon('refresh-cw')+' Refresh','refresh','ghost')}</div><div class="ar-list"><div class="ar-list-label"><span>${found.length} reports</span><span>Outcome · Validation</span></div>${found.length?visible.map(x=>sourceRow(x,'reports')).join('')+listPager(found.length):empty('No matching reports','Clear filters to see saved reports.',button('Clear filters','clear-filters'))}</div>`;
  }
  function matchedFindings(x=reportSnapshots[state.id]||item()) {
    return findingsFor(x).filter(f=>(state.severity==='all'||f.priority===state.severity)&&(state.findingStatus==='all'||f.status===state.findingStatus)&&(f.title+' '+f.path).toLowerCase().includes(state.findingQuery.toLowerCase()));
  }
  function moveFinding(direction) {
    const matches=matchedFindings(),index=matches.findIndex(f=>f.id===state.finding),next=index+(direction==='next'?1:-1);
    if(!matches[next])return false;state.finding=matches[next].id;state.findingPage=Math.floor(next/25)+1;render();
    focusCurrentFinding();
    return true;
  }
  function focusCurrentFinding() {requestAnimationFrame(()=>{const heading=root.querySelector('.ar-finding-body h2');if(heading){heading.setAttribute('tabindex','-1');heading.scrollIntoView({block:'start'});heading.focus({preventScroll:true});}});}
  function saveCurrentFinding() {
    if(!can('action:prepare'))return;
    const key=item().id+':'+state.finding;state.savedDrafts[key]=state.drafts[key]??draftBaseline(key);updateDirty();
  }
  function selectedReviewDialog(focusFinding=null) {
    const selected=state.selected[item().id]||[],matches=new Set(matchedFindings().map(f=>f.id)),all=findingsFor(reportSnapshots[state.id]||item()),rows=all.filter(f=>selected.includes(f.id)),hidden=rows.filter(f=>!matches.has(f.id)).length;
    openDialog('Selected findings ('+rows.length+')',(hidden?notice(hidden+' selected findings are hidden by current filters.'):'')+(rows.length?`<ul class="ar-selection-review">${rows.map(f=>`<li><div>${badge(f.priority,f.priority==='P0'?'error':'warning')} <strong>${f.id}. ${esc(f.title)}</strong><p class="ar-small ar-muted">${esc(f.status)}${!matches.has(f.id)?' · Hidden by current filters':''}</p></div>${button('Remove','remove-selected:'+f.id,'small','aria-label="Remove finding '+f.id+' from selected feedback" '+(can('action:prepare')?'':'disabled'))}</li>`).join('')}</ul>`:empty('No selected findings','Use Include in feedback on a finding to select it.')),button('Done','dialog-close')+button('Prepare selected feedback','pub:choose-report','primary',!rows.length||!can('action:prepare')?'disabled':''),focusFinding?'remove-selected:'+focusFinding:rows.length?null:'dialog-close');
  }
  function reportDetail() {
    const x=reportSnapshots[state.id];
    if(!x)return queueBar()+heading('No saved report')+empty('No saved report','Open the source or task to follow its current investigation.',button('Open source','open:'+item().type+':'+item().id)+button('Back to reports','back','primary'));
    const all=findingsFor(x),active=['findings','evidence','details'].includes(state.tab)?state.tab:'findings',partial=x.completeness==='Partial',selected=state.selected[x.id] ||= [],hasP0=all.some(f=>f.priority==='P0'),readOnly=!can('action:prepare')?'disabled':'';
    let content='';
    if(active==='findings') {
      const matched=matchedFindings(x),position=matched.findIndex(f=>f.id===state.finding),pageCount=Math.max(1,Math.ceil(matched.length/25));
      if(position>=0)state.findingPage=Math.floor(position/25)+1;state.findingPage=Math.max(1,Math.min(state.findingPage,pageCount));
      const page=matched.slice((state.findingPage-1)*25,state.findingPage*25),chosen=page.find(f=>f.id===state.finding)||page[0];if(chosen)state.finding=chosen.id;
      const chosenIndex=page.findIndex(f=>f.id===state.finding),windowStart=Math.floor(Math.max(0,chosenIndex)/5)*5;
      const shown=state.indexExpanded?page:page.slice(windowStart,windowStart+5),findingPosition=matched.findIndex(f=>f.id===state.finding),draft=state.drafts[x.id+':'+state.finding]??draftBaseline(x.id+':'+state.finding),last=findingPosition>=matched.length-1;
      content=`<div class="ar-report-tools-toggle">${button('Filters & feedback','report-tools','small','aria-expanded="'+state.reportToolsOpen+'" aria-controls="ar-report-tools"')}<span class="ar-small ar-muted">${all.length} total · ${matched.length} matching · ${selected.length} selected${state.reportDirty?' · Unsaved edits':''}</span></div><div id="ar-report-tools" class="ar-report-tools" data-open="${state.reportToolsOpen}"><div class="ar-toolbar"><div class="ar-search">${field('Search all '+all.length+' findings','ar-finding-search',state.findingQuery,'search','placeholder="Title or file path" maxlength="160"')}</div>${select('Priority','ar-priority',[['all','All priorities'],...['P0','P1','P2','P3'].map(p=>[p,p+' · '+all.filter(f=>f.priority===p).length])],state.severity)}${select('Assessment','ar-finding-status',[['all','All assessments'],['Confirmed','Confirmed'],['Needs verification','Needs verification'],['Needs decision','Needs decision']],state.findingStatus)}${state.findingQuery||state.severity!=='all'||state.findingStatus!=='all'?button('Clear filters','clear-finding-filters','ghost small'):''}</div><div class="ar-draft-bar ar-row">${button('Selected ('+selected.length+')','review-selected','small',selected.length?'':'disabled')}<span id="ar-draft-state" class="ar-small ar-muted" role="status">${state.reportDirty?'Unsaved edits':'Saved'}</span><span class="ar-spacer"></span>${button('Select page','select-page','small',readOnly||!matched.length?'disabled':'')}${button('Clear selection','clear-selection','ghost small',readOnly||!selected.length?'disabled':'')}${button('Discard report drafts','discard-drafts','ghost small',readOnly||!Object.keys(state.drafts).some(key=>key.startsWith(x.id+':')&&isDraftChanged(key))?'disabled':'')}${button('Save all drafts','save-drafts','small',readOnly||!Object.keys(state.drafts).some(key=>key.startsWith(x.id+':')&&isDraftChanged(key))?'disabled':'')}</div></div>`;
      if(!matched.length)content+=empty('No matching findings','Try another search or clear the filters.',button('Clear finding filters','clear-finding-filters'));
      else content+=`<div class="ar-mobile-findings">${select('Current finding · '+matched.length+' matches','ar-finding-picker',matched.map(f=>[String(f.id),f.priority+' · '+f.id+'. '+f.title]),String(state.finding))}<div class="ar-row">${button(icon('arrow-left')+' Previous finding','finding-step:prev','small',findingPosition<=0?'disabled':'')}${button('Next finding '+icon('arrow-right'),'finding-step:next','small',last?'disabled':'')}</div></div><div class="ar-findings"><aside class="ar-finding-index" aria-label="Findings directory"><div class="ar-small ar-muted">${(state.findingPage-1)*25+(state.indexExpanded?0:windowStart)+1}–${(state.findingPage-1)*25+(state.indexExpanded?0:windowStart)+shown.length} of ${matched.length} findings</div>${shown.map(f=>`<button type="button" class="ar-finding-choice" data-action="finding:${f.id}" ${f.id===chosen.id?'aria-current="true"':''}><span>${badge(f.priority,f.priority==='P0'?'error':'warning')} <span class="ar-small">${esc(f.status)}${selected.includes(f.id)?' · Selected':''}</span></span><strong>${f.id}. ${esc(f.title)}</strong><small>${esc(f.path)}</small></button>`).join('')}${page.length>5?button(state.indexExpanded?'Collapse directory':'Show all '+page.length+' on this page','expand-index','ghost small'):''}</aside><article class="ar-panel ar-finding-body"><div><div class="ar-finding-heading"><h2>${esc(chosen.title)}</h2>${button(icon('link'),'copy-finding','ghost small','id="ar-copy-finding" aria-label="'+copyViewLabel().replace('view','finding')+' '+chosen.id+'" data-tooltip="'+copyViewLabel().replace('view','finding')+'"')}</div><p class="ar-small ar-muted">${esc(chosen.status)} · Finding ${chosen.id} / ${all.length} · ${esc(chosen.subject)}</p><div class="ar-row"><label class="ar-row ar-native-choice-label" for="ar-selected-finding"><input type="checkbox" id="ar-selected-finding" class="ar-native-choice" data-material-native ${readOnly} ${selected.includes(chosen.id)?'checked':''}>Include in feedback</label><span class="ar-spacer"></span>${badge(chosen.priority,chosen.priority==='P0'?'error':'warning')}</div></div><div><h3>Trigger & impact</h3><p>${esc(chosen.trigger)}</p></div><div><h3>Source evidence</h3><code>${esc(chosen.path)}</code><pre>${esc(chosen.excerpt)}</pre><p class="ar-small ar-muted">Illustrative source excerpt · Synthetic fixture</p></div><div><h3>Final recheck</h3><p>${esc(chosen.recheck)}</p></div>${publication.findingCard(chosen)}<div><label class="ar-field" for="ar-feedback">Feedback draft<textarea id="ar-feedback" ${readOnly?'readonly':''}>${esc(draft)}</textarea></label><p class="ar-small ar-muted">${readOnly?'Read-only · preparation permission required.':'Private · Session only'}</p></div><div class="ar-finding-footer"><div class="ar-row">${button(icon('arrow-left')+' Previous','finding-step:prev','small',findingPosition<=0?'disabled':'')}${readOnly?button('Next finding '+icon('arrow-right'),'finding-step:next','primary',last?'disabled':''):button(last?'Save draft':'Save draft & next','save-current-next','primary')}</div></div></article></div><div class="ar-pager"><span>Page ${state.findingPage} of ${pageCount}</span><div class="ar-row">${button('Previous page','finding-prev','small',state.findingPage===1?'disabled':'')}${button('Next page','finding-next','small',state.findingPage===pageCount?'disabled':'')}</div></div>`;
    }
    if(active==='evidence')content=evidence();
    if(active==='details')content=`<section class="ar-panel"><h2>${x.type==='issues'?'Saved follow-up plan':'Coverage & remaining work'}</h2><p>${x.type==='issues'?(x.kind==='Feature'?'Draft plan: implement selective export while retaining defaults. Dependency and import compatibility decisions must be resolved before the plan is ready.':'Verify the startup failure against a chosen exact source commit and record the observed result.'):'Changed-path coverage retained. Candidate rechecks completed; required E2E remains outstanding.'}</p>${button('Review saved plan','followup-plan','primary')}</section>`;
    const prepareReason=!can('action:prepare')?'Preparing an action requires preparation permission.':!fresh()?'Refresh current action guards before preparing.':'';
    const context=`<details class="ar-report-context"><summary>Report details · ${x.completeness} · ${x.delivery}</summary><div class="ar-stack"><p><strong>${esc(x.title)}</strong></p>${dt([['Source',(x.type==='issues'?'Imported Issue snapshot':'Original PR · a4d71e2')+' · fixture-revision-01'],['Report','report-'+x.id+' · v1 · immutable'],['Execution',badge(x.status,tone(x.status))],['Completeness',x.completeness],['Delivery',x.delivery],['Validation',x.validation],['Saved','21 Sep 2026, 09:20'],['Digest','synthetic-report-digest-01']])}<p>${partial?'Partial investigation retained. Remaining work is recorded in Details.':x.type==='issues'?(x.kind==='Bug'?'Assessment needs verification. Runtime reproduction is not confirmed.':'Draft plan retained. Compatibility decisions and maintainer acceptance remain pending.'):'Source review is complete. Required E2E validation remains outstanding.'}</p><div class="ar-row">${button('Open source','open:'+x.type+':'+x.id,'small')}${button('Open task','open:tasks:'+x.id,'small')}${button('Export JSON','report-export','ghost small')}</div></div></details>`;
    return queueBar()+`<header class="ar-report-identity"><div class="ar-kicker">${x.type==='issues'?'Issue':'PR'} #${x.id} · Report v1</div><h1>${esc(x.title)}</h1><div class="ar-row">${githubLink(x)}</div>${prepareReason?`<p id="ar-prepare-reason" class="ar-small ar-muted">${prepareReason}</p>`:''}</header>`+outcomeSummary(x)+(hasP0?notice('<strong>Unresolved P0 on the original revision.</strong> Approve is unavailable. '+button('Locate P0','locate-p0','small'),'error'):'')+(state.scenario==='stale'?notice('Findings describe the saved revision. '+button('Refresh action context','refresh','small'),'warning'):'')+context+tabs([{id:'findings',label:'Findings ('+all.length+')'},{id:'evidence',label:'Evidence'},{id:'details',label:'Details'}],active,'report-tab:')+content;
  }
  function specialState() {
    if(['pulls','issues','tasks','reports','comments','webhooks'].includes(state.page)&&!canReadSource())return empty('Repository access required','This account has no enabled grant for the synthetic source repository. Saved grants determine what is visible.',button('Review My account','page:account','primary'));
    if(state.scenario==='loading') return heading(names[state.page]||'Workspace','Loading the current repository scope…')+`<div class="ar-panel" role="status" aria-label="Loading"><div class="ar-skeleton" style="width:55%"></div><div class="ar-skeleton"></div><div class="ar-skeleton" style="width:80%"></div><div class="ar-skeleton"></div>${button('Complete sample load','state-normal')}</div>`;
    if(state.scenario==='error') return heading(names[state.page]||'Workspace','Current repository scope')+notice('Could not load '+(names[state.page]||'workspace').toLowerCase()+'. Check your connection and try again.','error')+empty('Connection interrupted','The request did not return usable data. Retry with the same scope.',button('Retry','state-normal','primary'));
    if(state.scenario==='empty') return heading(names[state.page]||'Workspace','Current repository scope')+empty('No '+(names[state.page]||'records').toLowerCase()+' yet','There are no records in this authorized scope.',button('Return to sample data','state-normal','primary'));
    if(state.scenario==='noaccess'||!permitted(state.page)) return empty('Access required','This account does not have permission to open this area.',button('My account','page:account','primary'));
    return null;
  }
  function render(options={}) {
    globalThis.ARMaterialControls?.closeMenus();
    if(state.page==='login')state.ops.signedOut=true;
    else if(state.ops.signedOut){state.page='login';state.id=null;state.tab='overview';state.queue=null;}
    const previousFocus=focusKey(), route=state.page+':'+(state.id||'')+':'+state.repo,routeChanged=lastRenderedRoute&&lastRenderedRoute!==route;
    root.dataset.page=state.page;
    root.dataset.nav=design.expanded?'expanded':'compact';root.style.setProperty('--ar-row-pad',design.compact?'12px':'18px');
    $('ar-role').value=state.role;$('ar-scenario').value=state.scenario;$('ar-repo').value=state.repo;
    const group=groups.find(g=>g.pages.includes(state.page));
    $('ar-nav').innerHTML=groups.map(g=>`<button type="button" data-action="page:${g.pages[0]}" ${g===group?'aria-current="page"':''}><span class="ar-nav-icon">${icon(g.icon)}</span><span>${g.label}</span></button>`).join('');
    const groupNav=!state.id&&group&&group.pages.length>1?`<nav class="ar-group" aria-label="${group.label} pages">${group.pages.filter(permitted).map(p=>`<button type="button" data-action="page:${p}" ${state.page===p?'aria-current="page"':''}>${names[p]}</button>`).join('')}</nav>`:'';
    let content=state.page==='login'?null:specialState();
    const corePage=['pulls','issues','tasks','reports'].includes(state.page),validItem=!state.id||state.page==='tasks'&&Boolean(followups.find(state.id))||fixtures.some(x=>x.id===state.id&&(!['pulls','issues'].includes(state.page)||x.type===state.page));
    if(!content&&corePage&&!validItem)content=heading('Record unavailable','This address does not identify a source in the synthetic workspace.')+empty('Record not found','Return to the current directory to choose a retained record.',button('Back to '+names[state.page],'back','primary'));
    if(!content) content=state.page==='pulls'||state.page==='issues'?(state.id?sourceDetail():sourceList()):state.page==='tasks'?(state.id?taskDetail():taskList()):state.page==='reports'?(state.id?reportDetail():reportList()):ops.render(state.page);
    const pending=canReadSource()&&validItem&&state.id&&['pulls','issues','tasks','reports'].includes(state.page)?pendingIntent():null;
    const freshness=state.scenario==='refresh-error'?notice('<strong>Refresh failed.</strong> Showing the last successful snapshot from '+esc(state.lastSuccess)+'. Actions that require current guards are unavailable. '+button('Retry refresh','refresh','small'),'warning'):'';
    const access=!can('action:prepare')&&state.page!=='login'?notice('Read-only feedback') : '';
    $('ar-main').innerHTML=groupNav+freshness+access+(pending?notice(ownsIntent(pending)?'Your action has an unconfirmed result. Its original payload is retained. '+button('Check saved submission','check-intent','small'):'Another account has an unconfirmed action for this source. New preparation is blocked until its owner resolves the saved submission.','warning'):'')+(content||empty('Page unavailable','Choose a destination from the navigation.'));
    $('ar-context').textContent=(['repositories','workers','accounts','account'].includes(state.page)?'Workspace':state.repo==='all'?'All repositories':state.repo==='fork'?'example/dashboard-ui-fixture-fork':'example/dashboard-ui-fixture')+' · Demo data';
    $('ar-context').title='Last loaded '+state.lastSuccess;
    const avatar=root.querySelector('.ar-avatar');if(avatar){avatar.textContent=accountInitials();avatar.setAttribute('aria-label','Open account menu for '+(currentAccount()?.displayName||currentAccount()?.username||'Demo account'));}
    root.querySelectorAll('[data-action="theme"]').forEach(el=>el.setAttribute('aria-label','Appearance: '+state.theme+'. Switch to '+(state.theme==='dark'?'light':'dark')+' theme'));
    root.querySelectorAll('[data-action="copy-view"]').forEach(el=>{el.setAttribute('aria-label',copyViewLabel());el.setAttribute('data-tooltip',copyViewLabel());el.removeAttribute('title');});
    paintIcons();lastRenderedRoute=route;
    viewChanged();
    if(!$('ar-dialog').open&&!options?.deferFocus){if(routeChanged)focusMain();else if(previousFocus&&!focusByKey(previousFocus))focusMain();}
  }
  function retainInputRender(el, callback) {
    const id=el.id, position=el.selectionStart;callback();const target=$(id);if(target){target.focus();if(typeof position==='number'&&target.type!=='number')try{target.setSelectionRange(position,position);}catch{}}
  }
  function inputValue(id) {return $(id)?.value ?? '';}
  function trackCoreInput(el) {
    if(el.id==='ar-import-url'){dialogDirty=true;return true;}
    if(!coreForm||!el.closest('#ar-dialog-body'))return false;
    if(coreForm.kind==='prepare'){const draft=captureActionDraft();if($('ar-feedback-snapshot'))$('ar-feedback-snapshot').innerHTML=feedbackStatus(draft);}
    else if(coreForm.kind==='start')captureStartDraft();
    else if(coreForm.kind==='resume'&&el.id.startsWith('ar-resume-'))state.resumeDrafts[coreForm.key][el.id.slice(10)]=el.value;
    else if(coreForm.kind==='followup'&&el.id==='ar-plan-sha')actionDraft().sha=el.value;
    else return false;
    dialogDirty=true;return true;
  }
  function errorSummary(message='Check the highlighted fields before continuing.') {
    $('ar-form-error')?.remove();
    const errors=Array.from($('ar-dialog-body').querySelectorAll('.ar-inline-error'));
    $('ar-dialog-body').insertAdjacentHTML('afterbegin',`<div id="ar-form-error" class="ar-notice error" role="alert"><strong>${esc(message)}</strong>${errors.length?`<ul>${errors.map(el=>`<li>${button(esc(el.textContent),'focus-field:'+el.dataset.field,'ghost small')}</li>`).join('')}</ul>`:''}</div>`);
  }
  function clearFieldError(el) {
    if(!el?.id)return;
    const error=$(el.id+'-error');
    if(error?.classList.contains('ar-inline-error')){error.remove();el.removeAttribute('aria-invalid');const ids=(el.getAttribute('aria-describedby')||'').split(' ').filter(id=>id!==el.id+'-error');if(ids.length)el.setAttribute('aria-describedby',ids.join(' '));else el.removeAttribute('aria-describedby');if($('ar-dialog-body').querySelector('.ar-inline-error'))errorSummary();else $('ar-form-error')?.remove();}
  }
  function dialogError(text,id) {
    const target=id?$(id):null;
    if(target){clearFieldError(target);target.setAttribute('aria-invalid','true');const errorId=id+'-error';target.setAttribute('aria-describedby',[target.getAttribute('aria-describedby'),errorId].filter(Boolean).join(' '));target.insertAdjacentHTML('afterend',`<span id="${esc(errorId)}" class="ar-inline-error" data-field="${esc(id)}">${esc(text)}</span>`);const details=target.closest('details');if(details)details.open=true;}
    errorSummary(id?'Check the highlighted fields before continuing.':text);
    if(target){target.focus();target.scrollIntoView({block:'nearest'});}
  }
  function importDialog() {openDialog('Import source snapshot',notice('Demo import · No GitHub request')+field('GitHub pull request or issue URL','ar-import-url','https://github.com/example/dashboard-ui-fixture/pull/2106','url'),button('Cancel','dialog-close')+button('Import snapshot','import-submit','primary'));}
  function startDialog() {
    const x=item(),key=sourceKey(x);
    if(!can('task:create')||!fresh())return;
    if(state.startRequests[key]?.status==='unknown'){startRecoveryDialog();return;}
    if(['Running','Queued','Cancelling'].includes(x.status)){openDialog('Investigation already active',notice('This source already has an active synthetic investigation. Open its task to follow execution instead of creating duplicate work.'),button('Close','dialog-close')+button('Open current task','open:tasks:'+x.id,'primary'));return;}
    const d=state.startDrafts[key] ||= {mode:x.type==='issues'?'snapshot':'source',sha:x.type==='issues'?'':originalCommit,rounds:'8',minutes:'30',tokens:'20000',report:'2'};
    openDialog(x.type==='issues'?'Investigate issue':'Start pull request review',`<div class="ar-panel"><strong>${esc(x.title)}</strong><p class="ar-small ar-muted">#${x.id} · fixture-revision-01</p></div>`+(x.type==='issues'?select('Investigation mode','ar-start-mode',[['snapshot','Imported snapshot only'],['source','Read exact source']],d.mode)+`<div id="ar-start-sha-wrap" ${d.mode!=='source'?'hidden':''}>${field('Full source commit SHA','ar-start-sha',d.sha,'text','placeholder="40–64 hexadecimal characters"')}</div>`:notice('Read exact original PR source · a4d71e2. Static investigation does not start repository execution.'))+`<details><summary>Budget limits</summary><div class="ar-grid">${field('Rounds','ar-budget-rounds',d.rounds,'number','min="1"')}${field('Duration (minutes)','ar-budget-minutes',d.minutes,'number','min="1"')}${field('Tokens','ar-budget-tokens',d.tokens,'number','min="1"')}${field('Report limit (MiB) · configured','ar-budget-report',d.report,'number','readonly')}</div></details>`,button('Cancel','dialog-close')+button('Create investigation','start-submit','primary',!can('task:create')?'disabled':''));
    coreForm={kind:'start',key,initial:{...d}};
  }
  function captureStartDraft() {
    const d=state.startDrafts[sourceKey()];if(!d)return null;
    for(const [key,id] of Object.entries({mode:'ar-start-mode',sha:'ar-start-sha',rounds:'ar-budget-rounds',minutes:'ar-budget-minutes',tokens:'ar-budget-tokens',report:'ar-budget-report'}))if($(id))d[key]=inputValue(id);
    return d;
  }
  function startRecoveryDialog() {
    const request=state.startRequests[sourceKey()];if(!request)return;
    openDialog('Creation result unconfirmed',notice('The response was lost. Keep request '+esc(request.id)+'; recovery uses the exact saved inputs and cannot create a second task.','warning')+`<pre>${esc(JSON.stringify(request.inputs,null,2))}</pre>`,button('Close','dialog-close')+button('Recover original request','start-recover','primary',!can('task:create')?'disabled':''));
  }
  function queueCreatedTask(d) {
    const rowOrigin=dialogOrigin;
    const x=item();x.status='Queued';x.mode='Static';attemptCounts[x.id]=(attemptCounts[x.id]||0)+1;state.taskBudgets[sourceKey(x)]={tokens:Number(d.tokens),rounds:Number(d.rounds),minutes:Number(d.minutes),report:Number(d.report)};
    dialogDirty=false;closeDialog();nav('tasks',x.id,{rowOrigin});
    state.attempt=String(attemptCounts[x.id]);render();
  }
  function resumeDialog() {
    const x=item(),key=sourceKey(x),saved=taskBudget(x),consumed=taskConsumption(x),d=state.resumeDrafts[key] ||= {...saved};
    if(!canResume()||!fresh())return;
    const blocked=x.status==='Blocked'&&!state.resolvedPrerequisites?.[key];
    openDialog('Resume from saved checkpoint',notice('Source, scope, profile and prompt remain frozen. Saved limits cannot decrease; increase only the limits already exhausted.')+(blocked?notice('The build prerequisite is still blocked. A new attempt does not repair it. Check prerequisites after the Worker is ready. '+button('Check prerequisites','resume-preflight','small'),'warning'):x.status==='Blocked'?notice('Synthetic prerequisite check passed. Resume can now use the saved plan.','success'):'')+`<p><strong>Consumed:</strong> ${consumed.tokens.toLocaleString()} tokens · ${consumed.rounds} rounds · ${consumed.minutes} minutes · ${consumed.report} MiB</p><div class="ar-grid">${field('Token limit (saved: '+saved.tokens.toLocaleString()+')','ar-resume-tokens',d.tokens,'number',`min="${saved.tokens}" step="1"`)}${field('Rounds (saved: '+saved.rounds+')','ar-resume-rounds',d.rounds,'number',`min="${saved.rounds}" step="1"`)}${field('Duration minutes (saved: '+saved.minutes+')','ar-resume-minutes',d.minutes,'number',`min="${saved.minutes}"`)}${field('Report MiB (saved: '+saved.report+')','ar-resume-report',d.report,'number',`min="${saved.report}"`)}</div>`,button('Cancel','dialog-close')+button('Resume task','resume-submit','primary',!canResume()||blocked?'disabled':''));
    coreForm={kind:'resume',key,initial:{...d}};
  }
  function feedbackSnapshot(x=item()) {
    const selected=new Set(state.selected[x.id]||[]),entries=findingsFor(reportSnapshots[x.id]||x).filter(f=>selected.has(f.id)).map(f=>({finding:f.id,title:f.title,feedback:state.drafts[x.id+':'+f.id]??draftBaseline(x.id+':'+f.id)}));
    const serialized=JSON.stringify(entries);let hash=2166136261;for(let i=0;i<serialized.length;i++)hash=Math.imul(hash^serialized.charCodeAt(i),16777619);
    return Object.freeze({id:'feedback-'+x.id+'-'+(hash>>>0).toString(16),report:'report-'+x.id+' · v1',entries:Object.freeze(entries.map(entry=>Object.freeze(entry)))});
  }
  const feedbackBody=snapshot=>snapshot.entries.map(entry=>entry.feedback).join('\n\n');
  function actionDraft(x=item()) {
    if(state.actionDrafts[sourceKey(x)])return state.actionDrafts[sourceKey(x)];
    const snapshot=feedbackSnapshot(x),body=feedbackBody(snapshot);
    return state.actionDrafts[sourceKey(x)]={operation:'comment',body,generatedBody:body,bodyMode:'selected-feedback',feedbackSnapshot:snapshot,acknowledgedSnapshotId:snapshot.id,method:'Squash',workflow:'validation.yml',sha:x.type==='issues'?'':originalCommit,path:'src/settings/SettingsMigration.cs',line:'42'};
  }
  function feedbackNeedsReview(d=actionDraft()) {const current=feedbackSnapshot();return current.id!==d.feedbackSnapshot.id&&current.id!==d.acknowledgedSnapshotId;}
  function feedbackStatus(d=actionDraft()) {
    const current=feedbackSnapshot(),changed=current.id!==d.feedbackSnapshot.id,unreviewed=feedbackNeedsReview(d);
    return (unreviewed?notice('<strong>Out of date.</strong> Selected findings or their feedback changed after this body was created. Replace it with current selected feedback, or explicitly keep this body as independent manual text.','warning'):changed?notice('Manual body kept after reviewing the changed selection. Current selected feedback is not automatically inserted.'):notice(d.bodyMode==='manual'?'Manual body. Selected feedback is supporting context; it is not automatically synchronized.':'Body matches its selected feedback snapshot.'))+`<p class="ar-small ar-muted">Body basis: ${esc(d.feedbackSnapshot.id)} · Current selection: ${esc(current.id)} · ${current.entries.length} selected</p><div class="ar-row">${button('Replace with current selected feedback','action-replace','small')}${unreviewed?button('Keep body as manual text','action-keep-body','ghost small'):''}</div>`;
  }
  function captureActionDraft() {
    const d=actionDraft(),oldBody=d.body;
    for(const [key,id] of Object.entries({operation:'ar-operation',body:'ar-action-body',method:'ar-merge-method',workflow:'ar-workflow',sha:'ar-action-sha',path:'ar-suggestion-path',line:'ar-suggestion-line'}))if($(id))d[key]=inputValue(id);
    if(d.body!==oldBody)d.bodyMode=d.body===d.generatedBody&&feedbackSnapshot().id===d.feedbackSnapshot.id?'selected-feedback':'manual';
    return d;
  }
  let pendingReplacement=null;
  function restorePreparation(context) {prepareDialog();if(context?.form)coreForm=context.form;dialogDirty=Boolean(context?.dirty);}
  function prepareDialog() {
    if(pendingIntent()){unknownActionDialog(pendingIntent());return;}
    if(!can('action:prepare')||!fresh())return;
    const x=item(),p0=findingsFor(x).some(f=>f.priority==='P0'),options=x.type==='issues'?[['comment','Comment'],['close','Close issue'],['followup','Start saved follow-up plan']]:[['comment','Comment'],['approve','Approve'+(p0?' · unavailable: unresolved P0':'')],['request-changes','Request changes'],['suggestion','Code suggestion comment'],['merge','Merge'],['close','Close PR'],['ci','Trigger CI'],['followup','Verify saved plan']];
    const d=actionDraft(x);
    openDialog('Prepare action',notice('Recommendation: '+assessmentFor(x).next+'. '+assessmentFor(x).reason+' Availability is checked independently.')+select('Operation','ar-operation',options,d.operation)+`<div id="ar-operation-options"></div><div id="ar-feedback-snapshot">${feedbackStatus(d)}</div><label class="ar-field" for="ar-action-body">Exact feedback body<textarea id="ar-action-body">${esc(d.body)}</textarea></label><p class="ar-small ar-muted">Private preparation draft · no selected feedback is appended automatically.</p>`,button('Cancel','dialog-close')+button('Prepare exact preview','prepare-submit','primary',!can('action:prepare')?'disabled':''));
    coreForm={kind:'prepare',key:sourceKey(x),initial:{...d}};operationOptions();
  }
  function operationOptions() {
    globalThis.ARMaterialControls?.closeMenus();
    queueMicrotask(()=>globalThis.ARMaterialControls?.sync());
    const d=actionDraft(),op=d.operation,p0=findingsFor(item()).some(f=>f.priority==='P0'),permissionReason=prepareOperationReason(op);
    const submit=$('ar-dialog-foot').querySelector('[data-action="prepare-submit"]');if(submit)submit.disabled=Boolean(permissionReason);
    $('ar-operation-options').innerHTML=(permissionReason?notice(permissionReason,'warning'):'')+(op==='approve'&&p0?notice('Approve is blocked by a confirmed, unresolved P0 on the original revision. Selection and pagination do not change this rule.','error'):op==='merge'?select('Merge method','ar-merge-method',['Squash','Merge commit','Rebase'],d.method)+notice('Merge has independent target and permission guards. A P0 is not used as its automatic content prohibition.','warning'):op==='ci'?field('Workflow file','ar-workflow',d.workflow):op==='followup'?notice('Uses a persisted saved plan and its exact prerequisites.')+field('Full source commit SHA','ar-action-sha',d.sha):op==='close'?notice('This closes the selected source on GitHub after a separate confirmation.','warning'):op==='suggestion'?notice('Code suggestions do not implicitly choose Request changes.')+field('File path','ar-suggestion-path',d.path)+field('Line','ar-suggestion-line',d.line,'number','min="1" step="1"'):' ');
  }
  function unknownActionDialog(p) {
    if(!p)return;
    if(p.publisher){publication.receipt(p);return;}
    if(!ownsIntent(p)){state.preview=null;openDialog(canReadSource()?'Another submission is unresolved':'Repository access required',notice(canReadSource()?'This source has an unconfirmed submission. Only the account that created it can inspect the exact payload or check its receipt. New preparation remains blocked.':'This account cannot inspect submissions in this repository.','warning')+(canReadSource()?dt([['Pending intent',esc(p.id)],['State','Acknowledgement unknown']]):''),button('Close','dialog-close'));return;}
    state.preview=p;
    openDialog('Submission result unknown',notice('Do not resubmit. Check the existing intent '+esc(p.id)+' and its receipt. This source cannot prepare another operation until it is resolved.','warning')+dt([['Target',p.sourceType+' #'+p.itemId],['Operation',esc(p.operation)]])+`<p>Operation and payload stay bound to the original intent.</p><pre>${esc(JSON.stringify(p.payload,null,2))}</pre>`,button('Close','dialog-close')+button('Check existing submission','reconcile','primary'));
  }
  function previewDialog() {
    if(state.preview?.publisher){publication.previewIntent(state.preview);return;}
    const p=state.preview;if(!ownsIntent(p)){if(p?.status==='unknown')unknownActionDialog(p);else{state.preview=null;toast('This account cannot inspect that prepared action.');}return;}const feedback=p.feedbackContext;
    const provenance=feedback?`<section class="ar-panel"><h3>Selected feedback snapshot</h3>${dt([['Selected findings',feedback.current.entries.length?feedback.current.entries.map(entry=>'#'+entry.finding).join(', '):'None'],['Current selection',esc(feedback.current.id)],['Body basis',esc(feedback.bodyBasis.id)],['Body mode',feedback.mode==='manual'?'Independent manual text':'Generated from selected feedback']])}${feedback.changed?notice('The selection changed after the body basis was captured. You explicitly kept the body as manual text; its contents were not replaced.','warning'):''}<details><summary>Inspect selected feedback (${feedback.current.entries.length})</summary>${feedback.current.entries.map(entry=>`<div><h4>${entry.finding}. ${esc(entry.title)}</h4><p>${esc(entry.feedback)}</p></div>`).join('')||'<p>No selected feedback.</p>'}</details></section>`:'';
    openDialog('Review exact action preview',notice('Prepared only · No operation has been executed.')+dt([['Target',`${p.sourceType} #${p.itemId} · example/dashboard-ui-fixture`],['Operation',esc(p.operation)],['Expected source',p.operation==='followup'?esc(p.payload.commit):p.sourceType==='Issue'?'Imported Issue snapshot · fixture-revision-01':'Original PR · a4d71e2 · fixture-revision-01'],['Report','report-'+p.itemId+' · v1'],['Intent',p.id+' · version 1'],['Payload digest','synthetic-payload-digest-01']])+provenance+`<section class="ar-panel"><h3>Exact payload</h3><pre>${esc(JSON.stringify(p.payload,null,2))}</pre></section>`+(!canExecute(p.operation)?notice('This account can prepare a preview, but execution needs action:execute, the '+esc(actionCapability(p.operation))+' capability'+(p.operation==='followup'?' and task:create plus a repository execution grant':'')+'.','warning'):'')+(state.scenario==='stale'||!fresh()?notice('Current action guards are unavailable or outdated. Refresh the action context and prepare again.','error'):''),button('Back to preparation','prepare')+button('Confirm '+p.operation,'confirm-action',/close|merge/.test(p.operation)?'danger':'primary',!canExecute(p.operation)||state.scenario==='stale'||!fresh()?'disabled':''));
  }
  function showJourneys() {openDialog('Try an interaction flow',`<div class="ar-map">${[['Review → findings → exact action','journey:review'],['26 findings → off-page P0','journey:p0'],['Interrupted → raise budget → resume','journey:resume'],['Bug → exact-source follow-up','journey:issue'],['Live task → output → cancellation','journey:task'],['Comments → delivery recovery','journey:comments'],['Webhook → handling recovery','journey:webhooks'],['Worker → disable → cleanup pending','journey:workers'],['Repository → settings','journey:repositories'],['Accounts → permissions','journey:accounts'],['Sign-in → workspace','journey:login']].map(([t,a])=>button(t,a)).join('')}</div>`,button('Close','dialog-close'));}
  function searchDialog() {openDialog('Search workspace',field('Search source titles, numbers, tasks and reports','ar-global-search','','search','placeholder="At least two characters"')+`<div id="ar-global-results" aria-live="polite"><p class="ar-muted">Results are limited to repositories this account can access.</p></div>`,button('Close','dialog-close'));$('ar-global-search').focus();}
  function searchResults(query) {
    if(!canReadSource())return empty('Repository access required','No searchable records in this account.');
    if(state.repo==='fork')return empty('No results in this repository','Search all repositories to include the demo sources.',button('Search all repositories','search-all-repositories'));
    const q=query.toLowerCase().trim();
    if(q.length<2)return '<p class="ar-muted">Enter at least two characters.</p>';
    const records=[...followups.list().map(x=>({...x,searchPage:'tasks'})),...fixtures.map(x=>({...x,searchPage:x.type}))].filter(x=>(x.title+' '+x.id+' '+(x.number||'')).toLowerCase().includes(q));
    return records.map(x=>`<div class="ar-row" style="margin-bottom:10px">${button(esc(x.sourceId?x.title:'#'+x.id+' · '+x.title),'open:'+x.searchPage+':'+x.id,'ghost')}${!x.sourceId&&hasRecord('tasks',x.id)?button('Task','open:tasks:'+x.id,'small'):''}${!x.sourceId&&reportSnapshots[x.id]?button('Report','open:reports:'+x.id,'small'):''}</div>`).join('')||empty('No matching results','Try a source number, task ID or title.');
  }
  function handle(action,el) {
    if(action.startsWith('pub:')){publication.handle(action,el);return;}
    if(action.startsWith('ops:')){ops.handle(action,el);return;}
    const [verb,a,b]=action.split(':');
    if(verb==='recommended'&&a&&b){openRowAction(a,b,el);return;}
    if(['check-intent','reconcile','snapshot','artifact','report-export','output-export'].includes(action)&&!canReadSource()){toast('Repository access is required to inspect this record.');return;}
    if(action==='recommended'){runRecommendation();return;}
    if(action==='outcome-evidence'){openOutcomeEvidence();return;}
    if(verb==='focus-field'){$(action.slice('focus-field:'.length))?.focus();return;}
    const requiredPermission=['import','import-submit'].includes(action)?'repository:manage':['start','start-submit','start-recover','resume','resume-submit','resume-preflight'].includes(action)?'task:create':['cancel-task','cancel-confirm'].includes(action)?'task:cancel':['prepare','prepare-submit','plan-prerequisites','action-selected','action-replace','action-replace-confirm','action-keep-body','save-current-next','discard-drafts','discard-drafts-confirm'].includes(action)?'action:prepare':null;
    if(requiredPermission&&!can(requiredPermission)){toast('This action requires '+requiredPermission+' and access to this repository.');return;}
    if(['import','import-submit','start','start-submit','resume','resume-submit','resume-preflight','cancel-task','cancel-confirm','prepare','prepare-submit','confirm-action'].includes(action)&&!fresh()){toast('Refresh the retained snapshot before using an action that needs current guards.');return;}
    if(verb==='page'){nav(a);return;} if(verb==='open'){const fromListRow=Boolean(el?.matches?.('.ar-source-row,.ar-source-open,.ar-source-chevron'));nav(a,b,{captureQueue:fromListRow&&!state.id&&a===state.page&&!$('ar-dialog').open&&corePages.includes(a),opener:fromListRow?focusKey(el):null});return;}
    if(verb==='queue'){const q=state.queue,index=q?.ids.indexOf(q.originMemberId||state.id)??-1,id=q?.ids[index+(a==='next'?1:-1)];if(index>=0&&id){const destination=hasRecord(state.page,id)?state.page:q.origin;nav(destination,id,{queueItem:true});}return;}
    if(verb==='remove-selected'){if(!can('action:prepare'))return;const selected=state.selected[item().id]||[],ordered=findingsFor(reportSnapshots[state.id]||item()).filter(f=>selected.includes(f.id)).map(f=>f.id),index=ordered.indexOf(Number(a)),next=ordered[index+1]||ordered[index-1]||null;state.selected[item().id]=selected.filter(id=>id!==Number(a));render();selectedReviewDialog(next);return;}
    if(verb==='journey'){const targets={review:['reports','2101'],p0:['reports','2102'],resume:['tasks','2103'],issue:['issues','3101'],task:['tasks','2203'],comments:['comments'],webhooks:['webhooks'],workers:['workers'],repositories:['repositories'],accounts:['accounts'],login:['login']};guardNavigation(()=>{state.scenario='normal';nav(...targets[a]);});return;}
    if(verb==='source-tab'||verb==='task-tab'||verb==='report-tab'){setSection(a);return;}
    if(verb==='filter'){currentList().status=a;currentList().page=1;render();return;}
    if(verb==='finding'){state.finding=Number(a);render();return;}
    if(verb==='finding-step'){moveFinding(a);return;}
    switch(action) {
      case 'dismiss-toast':clearToast();break;
      case 'prototype-settings':{const settings=$('ar-prototype-settings');settings.open=!settings.open;root.querySelector('[data-action="prototype-settings"]').setAttribute('aria-expanded',String(settings.open));if(settings.open)$('ar-role').focus();}break;
      case 'back':back();break;
      case 'dialog-close':if(pendingReplacement){const previous=pendingReplacement;pendingReplacement=null;restorePreparation(previous);}else if(dialogDirty){guardNavigation(closeDialog,'dialog');}else closeDialog();break;
      case 'guard-stay':pendingNavigation=null;if(historyTraversal)historyTraversal.cancelled=true;if(pendingDialog){const previous=pendingDialog;pendingDialog=null;openDialog(previous.title,'','');$('ar-dialog-body').append(...previous.bodyNodes);$('ar-dialog-foot').append(...previous.footerNodes);dialogDirty=previous.dirty;coreForm=previous.form;paintIcons();focusByKey(previous.focus);}else closeDialog();$('ar-role').value=state.role;$('ar-scenario').value=state.scenario;$('ar-repo').value=state.repo;paintIcons();break;
      case 'guard-discard':discardCoreForm(pendingDialog?.form);if(guardScope==='all'){state.drafts={...state.savedDrafts};if(ops.discardDirty)ops.discardDirty();else{state.ops.dirty=false;state.ops.repoDrafts={};state.ops.accountDrafts={};delete state.ops.globalConcurrencyDraft;}}updateDirty();dialogDirty=false;pendingDialog=null;closeDialog();{const fn=pendingNavigation;pendingNavigation=null;fn?.();}break;
      case 'skip-main':focusMain();break;
      case 'theme':state.theme=state.theme==='dark'?'light':'dark';root.style.colorScheme=state.theme;root.querySelectorAll('[data-action="theme"]').forEach(target=>target.setAttribute('aria-label','Appearance: '+state.theme+'. Switch to '+(state.theme==='dark'?'light':'dark')+' theme'));toast('Appearance changed to '+state.theme+'.');break;
      case 'account-menu':openDialog('My account',`<div class="ar-row"><span class="ar-mark">${esc(accountInitials())}</span><div><strong>${esc(currentAccount()?.displayName||'Demo account')}</strong><p class="ar-muted">${esc(currentAccount()?.username||'')}</p></div></div>`,button(copyViewLabel(),'copy-view')+button('Switch appearance','theme')+button('Account settings','page:account')+button('Sign out','sign-out'));break;
      case 'copy-view':case 'copy-finding':void copyView();break;
      case 'sign-out':guardNavigation(()=>{ops.discardDirty?.();clearPrivateSession();state.scenario='normal';nav('login');});break;
      case 'state-normal':state.scenario='normal';render();break;
      case 'refresh':state.scenario='normal';state.lastSuccess='21 Sep 2026, 09:35';render();toast('Demo snapshot refreshed.');break;
      case 'list-prev':currentList().page=Math.max(1,currentList().page-1);render();restoreScroll();break;
      case 'list-next':currentList().page++;render();restoreScroll();break;
      case 'clear-filters':state.lists[state.page]={q:'',status:'all',source:'all',type:'all',delivery:'all',page:1};if($('ar-dialog-status'))$('ar-dialog-status').value='all';if($('ar-dialog-source'))$('ar-dialog-source').value='all';render();break;
      case 'filters':openDialog('Source filters',select('Investigation state','ar-dialog-status',[['all','All investigations'],'Needs review','Queued','Running','Blocked','Interrupted','Cancelling','Cancelled','Failed','Completed'],currentList().status)+select('Source state','ar-dialog-source',[['all','All states'],['open','Open'],['closed','Closed']],currentList().source),button('Reset','filters-reset','ghost')+button('Cancel','dialog-close')+button('Apply filters','filters-apply','primary'));break;
      case 'filters-reset':$('ar-dialog-status').value='all';$('ar-dialog-source').value='all';globalThis.ARMaterialControls?.sync();$('ar-dialog-status').focus();break;
      case 'filters-apply':currentList().status=inputValue('ar-dialog-status');currentList().source=inputValue('ar-dialog-source');currentList().page=1;closeDialog();render();break;
      case 'import':importDialog();break;
      case 'import-submit':{const value=inputValue('ar-import-url').trim(),match=value.match(/^https:\/\/github\.com\/example\/dashboard-ui-fixture\/(pull|issues)\/(\d+)\/?$/);if(!match||!Number.isSafeInteger(Number(match[2]))||Number(match[2])<1){dialogError('Use a valid PR or issue URL in example/dashboard-ui-fixture.','ar-import-url');break;}const id=String(Number(match[2])),type=match[1]==='pull'?'pulls':'issues';if(fixtures.some(x=>x.id===id&&x.type!==type)){dialogError('This fixture number belongs to another source type. Check the URL.','ar-import-url');break;}if(!fixtures.some(x=>x.id===id))fixtures.unshift({id,number:Number(id),repositoryFullName:'example/dashboard-ui-fixture',synthetic:true,type:match[1]==='pull'?'pulls':'issues',title:'Imported synthetic source #'+id,status:'Needs review',conclusion:'No report',validation:'Not run',mode:'Static',tokens:0});state.scenario='normal';state.lastSuccess='21 Sep 2026, 09:35';closeDialog();nav(type,id);toast('Demo snapshot reloaded.');break;}
      case 'snapshot':openDialog('Recorded source snapshot',dt([['Repository','example/dashboard-ui-fixture'],['Source','#'+item().id],['Revision','fixture-revision-01'],['Commit',item().type==='issues'?'Not chosen for this Issue snapshot':originalCommit],['Discussion','2 retained comments'],['Imported','21 Sep 2026, 09:10']]),button('Close','dialog-close'));break;
      case 'start':startDialog();break;
      case 'start-submit':{
        if(!can('task:create'))break;
        if(state.startRequests[sourceKey()]?.status==='unknown'){startRecoveryDialog();break;}
        if(['Running','Queued','Cancelling'].includes(item().status)){startDialog();break;}
        const d=captureStartDraft();if(!d)break;
        if(d.mode==='source'&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(d.sha.trim())){dialogError('Enter a full 40- or 64-character hexadecimal commit SHA.','ar-start-sha');break;}
        const invalidBudget=['rounds','minutes','tokens'].filter(key=>!Number.isInteger(Number(d[key]))||Number(d[key])<1);if(invalidBudget.length){invalidBudget.forEach(key=>dialogError('Enter a positive whole number for '+key+'.','ar-budget-'+key));$('ar-form-error')?.querySelector('button')?.focus();break;}
        if(state.scenario==='conflict'){openDialog('Source changed',notice('The saved source revision no longer matches. Your source choice and budget are retained. Review the latest snapshot before creating a task.','warning'),button('Close','dialog-close')+button('Review updated source','source-refresh','primary'));break;}
        if(state.scenario==='unknown'){state.startRequests[sourceKey()]={id:'create-'+item().id,inputs:{...d},status:'unknown'};startRecoveryDialog();break;}
        queueCreatedTask(d);toast('Synthetic investigation queued. No Worker started.');break;
      }
      case 'source-refresh':state.scenario='normal';startDialog();break;
      case 'start-recover':{const request=state.startRequests[sourceKey()];if(!can('task:create')||request?.status!=='unknown')break;request.status='accepted';state.scenario='normal';queueCreatedTask(request.inputs);toast('Existing synthetic task recovered using the retained request.');break;}
      case 'resume':resumeDialog();break;
      case 'resume-preflight':{const d=coreForm,wasDirty=dialogDirty;state.resolvedPrerequisites||={};state.resolvedPrerequisites[sourceKey()]=true;resumeDialog();if(d)coreForm=d;dialogDirty=wasDirty;toast('Synthetic prerequisite state changed to ready. No Worker check was sent.');break;}
      case 'resume-submit':{
        if(!canResume())break;
        if(!['Interrupted','Blocked','Failed','Cancelled'].includes(item().status))break;
        if(item().status==='Blocked'&&!state.resolvedPrerequisites?.[sourceKey()]){dialogError('The prerequisite is still blocked. Check prerequisites before resuming.');break;}
        const saved=taskBudget(),consumed=taskConsumption(),values=Object.fromEntries(['tokens','rounds','minutes','report'].map(key=>[key,Number(inputValue('ar-resume-'+key))]));
        const invalid=Object.keys(values).find(key=>!Number.isFinite(values[key])||values[key]<saved[key]||(['tokens','rounds'].includes(key)&&!Number.isInteger(values[key]))||values[key]<=consumed[key]);
        if(invalid){dialogError('Limits cannot decrease; tokens and rounds must be whole numbers. '+(saved[invalid]<=consumed[invalid]?'Increase '+invalid+' above the '+consumed[invalid]+' already consumed.':'Review the '+invalid+' limit.'),'ar-resume-'+invalid);break;}
        state.taskBudgets[sourceKey()]={...values};state.resumeDrafts[sourceKey()]={...values};item().status='Queued';attemptCounts[item().id]=(attemptCounts[item().id]||1)+1;state.attempt=String(attemptCounts[item().id]);closeDialog();render();toast('Resume queued with the same frozen inputs and reviewed budget.');break;
      }
      case 'cancel-task':openDialog('Cancel this task?',notice('Cancellation stops further execution. Active E2E ownership remains until its Worker confirms cleanup.','warning'),button('Keep running','dialog-close')+button('Request cancellation','cancel-confirm','danger'));break;
      case 'cancel-confirm':if(!['Running','Queued'].includes(item().status))break;item().status=item().mode==='E2E'?'Cancelling':'Cancelled';if(item().mode==='E2E')ops.taskEvent?.({type:'cancellation-requested',taskId:item().id,workerId:ownerWorker()?.id});closeDialog();render();toast(item().mode==='E2E'?'Cancellation requested. Worker cleanup confirmation is still pending.':'Synthetic task cancelled.');break;
      case 'latest-attempt':state.attempt=String(attemptCounts[item().id]||1);render();toast('Showing the latest retained attempt.');break;
      case 'output-latest':{const entries=root.querySelectorAll('.ar-log'),last=entries[entries.length-1];if(last){last.setAttribute('tabindex','-1');last.scrollIntoView({block:'nearest'});last.focus({preventScroll:true});}}break;
      case 'clear-output-filters':state.taskOutputQuery='';state.eventType='all';render();$('ar-output-search')?.focus({preventScroll:true});break;
      case 'output-export':download('synthetic-loaded-output.txt','Synthetic visible output for task-'+item().id+'\nAttempt '+state.attempt+'\n'+outputEntries().map(e=>e.time+' ['+e.type+'] '+e.title+'\n'+e.text).join('\n\n')+'\nExport scope: currently loaded and filtered output only.');break;
      case 'artifact':openDialog('Evidence provenance',notice('Content unavailable. A provenance record does not prove a runtime check passed.','warning')+dt([['Artifact','artifact-fixture-01'],['Task','task-'+item().id],['Attempt','attempt-fixture-01'],['Producer','fixture-desktop-worker'],['Subject','Original PR revision a4d71e2'],['Availability','Not retained in the prototype']]),button('Close','dialog-close'));break;
      case 'select-page':{if(!can('action:prepare'))break;const all=findingsFor(item()).filter(f=>(state.severity==='all'||f.priority===state.severity)&&(state.findingStatus==='all'||state.findingStatus===f.status)&&(f.title+' '+f.path).toLowerCase().includes(state.findingQuery.toLowerCase())).slice((state.findingPage-1)*25,state.findingPage*25);state.selected[item().id]=[...new Set([...(state.selected[item().id]||[]),...all.map(f=>f.id)])];render();break;}
      case 'clear-selection':if(!can('action:prepare'))break;state.selected[item().id]=[];render();break;
      case 'review-selected':if(canReadSource())selectedReviewDialog();break;
      case 'save-current-next':{saveCurrentFinding();const moved=moveFinding('next');if(!moved)render();toast(moved?'Draft saved.':'Draft saved · Last finding.');break;}
      case 'save-drafts':if(!can('action:prepare'))break;Object.keys(state.drafts).filter(key=>key.startsWith(item().id+':')).forEach(key=>state.savedDrafts[key]=state.drafts[key]);updateDirty();render();toast('Drafts saved for this session.');break;
      case 'discard-drafts':if(!can('action:prepare'))break;openDialog('Discard this report’s feedback edits?',notice('Only unsaved feedback for this report is discarded. Saved feedback and selected findings are kept.','warning'),button('Keep editing','dialog-close')+button('Discard report edits','discard-drafts-confirm','danger'));break;
      case 'discard-drafts-confirm':Object.keys(state.drafts).filter(key=>key.startsWith(item().id+':')).forEach(key=>{if(Object.hasOwn(state.savedDrafts,key))state.drafts[key]=state.savedDrafts[key];else delete state.drafts[key];});updateDirty();closeDialog();render();toast('Unsaved feedback for this report discarded.');break;
      case 'report-tools':state.reportToolsOpen=!state.reportToolsOpen;render();break;
      case 'expand-index':state.indexExpanded=!state.indexExpanded;render();break;
      case 'finding-next':state.findingPage++;state.finding=0;render();focusCurrentFinding();break;
      case 'finding-prev':state.findingPage=Math.max(1,state.findingPage-1);state.finding=0;render();focusCurrentFinding();break;
      case 'locate-p0':state.tab='findings';state.severity='P0';state.findingStatus='all';state.findingQuery='';state.findingPage=1;state.finding=findingsFor(reportSnapshots[state.id]||item()).find(f=>f.priority==='P0')?.id||1;render();focusCurrentFinding();toast('Showing unresolved P0.');break;
      case 'clear-finding-filters':state.severity='all';state.findingQuery='';state.findingStatus='all';state.findingPage=1;state.finding=0;render();break;
      case 'report-export':{const report=reportSnapshots[item().id];if(report)download('synthetic-report-'+report.id+'.json',{synthetic:true,id:'report-'+report.id,version:1,source:'fixture-revision-01',outcome:report.status,completeness:report.completeness,delivery:report.delivery,assessment:assessmentFor(report),findings:findingsFor(report),validation:report.validation,evidence:[{availability:'not_retained'}],plans:['saved-validation-plan']});break;}
      case 'prepare':publication.choose();break;
      case 'action-selected':case 'action-replace':{if(pendingIntent()){unknownActionDialog(pendingIntent());break;}const d=captureActionDraft(),snapshot=feedbackSnapshot();pendingReplacement={form:coreForm,dirty:dialogDirty};openDialog('Replace feedback body?',notice('This replaces the entire preparation body, including manual edits. Independent finding drafts and selected findings are unchanged.','warning')+`<p><strong>Replacement:</strong> ${snapshot.entries.length} selected findings · ${esc(snapshot.id)}</p><pre>${esc(feedbackBody(snapshot)||'(Empty body: no findings selected)')}</pre>`,button('Keep existing body','dialog-close')+button('Replace body','action-replace-confirm','danger'));coreForm=pendingReplacement.form;dialogDirty=pendingReplacement.dirty;break;}
      case 'action-replace-confirm':{if(!pendingReplacement||pendingIntent())break;const previous=pendingReplacement;pendingReplacement=null;const d=actionDraft(),snapshot=feedbackSnapshot(),body=feedbackBody(snapshot);Object.assign(d,{body,generatedBody:body,bodyMode:'selected-feedback',feedbackSnapshot:snapshot,acknowledgedSnapshotId:snapshot.id});restorePreparation({...previous,dirty:true});toast('Preparation body replaced with the current selected feedback snapshot.');break;}
      case 'action-keep-body':{const d=captureActionDraft();d.acknowledgedSnapshotId=feedbackSnapshot().id;d.bodyMode='manual';$('ar-feedback-snapshot').innerHTML=feedbackStatus(d);clearFieldError($('ar-action-body'));dialogDirty=true;$('ar-action-body').focus();toast('Existing body kept as independent manual text.');break;}
      case 'prepare-submit':{
        if(!can('action:prepare'))break;
        if(pendingIntent()){unknownActionDialog(pendingIntent());break;}
        const d=captureActionDraft(),op=d.operation,body=d.body;
        const permissionReason=prepareOperationReason(op);if(permissionReason){dialogError(permissionReason,'ar-operation');break;}
        if(feedbackNeedsReview(d)){dialogError('Selected feedback changed. Replace this body or explicitly keep it as manual text before preparing.','ar-action-body');break;}
        if(op==='approve'&&findingsFor(item()).some(f=>f.priority==='P0')){dialogError('Approve is unavailable while the original PR has a confirmed unresolved P0.','ar-operation');break;}
        if(['comment','request-changes','suggestion'].includes(op)&&!body.trim()){dialogError('Enter feedback or select findings before preparation.','ar-action-body');break;}
        if(op==='followup'&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(d.sha.trim())){dialogError('Choose the exact source commit required by the saved plan.','ar-action-sha');break;}
        if(op==='ci'&&!d.workflow.trim()){dialogError('Enter a workflow file.','ar-workflow');break;}
        if(op==='suggestion'&&(!d.path.trim()||/^(?:[\\/]|[A-Za-z]:)/.test(d.path)||d.path.split(/[\\/]/).includes('..'))){dialogError('Enter a repository-relative file path.','ar-suggestion-path');break;}
        if(op==='suggestion'&&(!Number.isInteger(Number(d.line))||Number(d.line)<1)){dialogError('The suggestion line must be a positive whole number.','ar-suggestion-line');break;}
        const currentFeedback=feedbackSnapshot(),key=sourceKey();state.preview={id:'intent-fixture-'+item().id+'-'+state.nextIntent++,actorId:currentAccount().id,itemId:item().id,sourceType:item().type==='issues'?'Issue':'PR',operation:op,status:'prepared',feedbackContext:{mode:d.bodyMode,bodyBasis:d.feedbackSnapshot,current:currentFeedback,changed:d.feedbackSnapshot.id!==currentFeedback.id},payload:{operation:op,body,selectedFindings:currentFeedback.entries.map(entry=>entry.finding),...(op==='merge'?{method:d.method}:{}),...(op==='ci'?{workflow:d.workflow}:{}),...(op==='followup'?{plan:'saved-validation-plan',commit:d.sha.trim()}:{}),...(op==='suggestion'?{path:d.path.trim(),line:Number(d.line)}:{})}};
        state.actionIntents[key]=state.preview;dialogDirty=false;previewDialog();break;
      }
      case 'confirm-action':{
        const p=state.preview;if(!p||!ownsIntent(p)||!canExecute(p.operation)||p.status!=='prepared'||state.scenario==='stale'||!fresh())break;
        if(state.scenario==='unknown'){p.status='unknown';unknownActionDialog(p);render();}
        else if(state.scenario==='conflict'){p.status='conflict';openDialog('Action context changed',notice('The prepared version is no longer current. Review updated guards before preparing another intent. Your preparation inputs are retained.','warning'),button('Refresh action context','action-refresh','primary'));}
        else{p.status='simulated';openDialog('Simulation receipt',notice('Confirmed in the prototype. No GitHub operation or Worker execution was dispatched.','success')+dt([['Intent',p.id],['Operation',p.operation],['Target','#'+p.itemId],['Result','Local simulation recorded']]),button('Done','dialog-close','primary'));}break;
      }
      case 'check-intent':unknownActionDialog(pendingIntent());break;
      case 'action-refresh':state.scenario='normal';prepareDialog();break;
      case 'reconcile':{const p=pendingIntent();if(!p)break;if(!ownsIntent(p)){unknownActionDialog(p);break;}p.status='simulated';state.preview=p;state.scenario='normal';render();openDialog('Existing submission checked',notice('The retained synthetic receipt is now resolved. No operation was resent.','success')+dt([['Intent',p.id],['Result','Recorded simulation receipt'],['New submissions','0']]),button('Done','dialog-close','primary'));break;}
      case 'followup-plan':{const d=actionDraft(),feature=item().kind==='Feature',bug=item().kind==='Bug';openDialog('Saved follow-up plan',`<h3>${feature?'Draft: selective Settings export':bug?'Verify the reported Settings startup failure':'Verify cancellation and saved configuration'}</h3><ol>${feature?'<li>Resolve dependency and import compatibility decisions with maintainers.</li><li>Record accepted behavior for omitted settings and defaults.</li><li>Implement only after the decisions are recorded.</li><li>Verify selective export and existing import compatibility.</li>':bug?'<li>Choose the exact commit and record the update environment.</li><li>Follow the reported update and Settings launch steps.</li><li>Record whether the window exits, with logs and available evidence.</li><li>Report reproduced, not reproduced or blocked; confirm cleanup.</li>':'<li>Prepare the exact saved source.</li><li>Exercise cancellation during migration.</li><li>Record the persisted settings and actual checks.</li><li>Confirm application cleanup.</li>'}</ol>`+notice(feature?'This is a draft plan. Maintainer decisions and acceptance are still pending.':'The plan is saved, but execution still needs source, permissions and Worker capacity.')+(prepareOperationReason('followup')?notice(prepareOperationReason('followup'),'warning'):'')+field('Chosen full commit SHA','ar-plan-sha',d.sha,'text',prepareOperationReason('followup')?'readonly':''),button('Close','dialog-close')+button('Review prerequisites','plan-prerequisites','primary',prepareOperationReason('followup')?'disabled':''));coreForm={kind:'followup',key:sourceKey(),initial:{...d}};break;}
      case 'plan-prerequisites':{const permissionReason=prepareOperationReason('followup');if(permissionReason){dialogError(permissionReason);break;}const sha=inputValue('ar-plan-sha').trim();if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(sha)){dialogError('Enter the full source commit SHA.','ar-plan-sha');break;}Object.assign(actionDraft(),{sha,operation:'followup'});openDialog('Follow-up prerequisites',notice('Source chosen. A saved plan does not by itself authorize execution.')+dt([['Saved plan','Available'],['Exact source',sha],['Execution permission',currentAccount()?.execution?'Granted in sample account':'Not granted'],['Worker admission','Needs fresh server check'],['Current guards','Pending authoritative preparation']]),button('Close','dialog-close')+button('Open preparation','pub:from-plan','primary',!can('action:prepare')?'disabled':''));break;}
      case 'journeys':showJourneys();break;
      case 'search':guardNavigation(searchDialog);break;
      case 'search-all-repositories':state.repo='all';render();$('ar-global-results').innerHTML=searchResults(inputValue('ar-global-search'));$('ar-global-search').focus();break;
    }
  }
  root.addEventListener('click',e=>{const link=e.target.closest('a[href^="#"]');if(link){const id=link.getAttribute('href').slice(1),fieldTarget=/^[A-Za-z0-9_.:-]+$/.test(id)?$(id):null;if(fieldTarget&&['INPUT','TEXTAREA','SELECT'].includes(fieldTarget.tagName)){e.preventDefault();fieldTarget.focus();return;}}const target=e.target.closest('[data-action]');if(target&&root.contains(target)&&!target.disabled)handle(target.dataset.action,target);});
  root.addEventListener('submit',e=>{const form=e.target.closest('form[data-ops-submit]');if(form){e.preventDefault();ops.handle(form.dataset.opsSubmit,form);}});
  root.addEventListener('input',e=>{
    const el=e.target;
    clearFieldError(el);
    if(el.dataset.pub){if(!['include','view','delivery','reason','method'].includes(el.dataset.pub))publication.change(el);return;}
    if(el.closest('#ar-dialog-body')&&el.dataset.ops?.startsWith('ephemeral.'))dialogDirty=Array.from($('ar-dialog-body').querySelectorAll('[data-ops^="ephemeral."]')).some(input=>input.type==='checkbox'?input.checked:Boolean(input.value));
    if(el.id==='ar-list-search'){currentList().q=textParam(el.value);currentList().page=1;retainInputRender(el,render);}
    else if(el.id==='ar-finding-search'){state.findingQuery=textParam(el.value);state.findingPage=1;state.finding=0;retainInputRender(el,render);}
    else if(el.id==='ar-feedback'){if(can('action:prepare')){state.drafts[item().id+':'+state.finding]=el.value;updateDirty();const changed=Object.keys(state.drafts).some(key=>key.startsWith(item().id+':')&&isDraftChanged(key));for(const action of ['discard-drafts','save-drafts']){const control=root.querySelector('[data-action="'+action+'"]');if(control)control.disabled=!changed;}if($('ar-draft-state'))$('ar-draft-state').textContent=changed?'Unsaved edits':'Saved';}}
    else if(el.id==='ar-output-search'){state.taskOutputQuery=textParam(el.value);retainInputRender(el,render);}
    else if(trackCoreInput(el)){}
    else if(el.id==='ar-global-search')$('ar-global-results').innerHTML=searchResults(el.value);
    else ops.change(el);
  });
  root.addEventListener('change',e=>{
    const el=e.target;
    clearFieldError(el);
    if(el.closest('#ar-dialog-body')&&el.dataset.ops?.startsWith('ephemeral.'))dialogDirty=Array.from($('ar-dialog-body').querySelectorAll('[data-ops^="ephemeral."]')).some(input=>input.type==='checkbox'?input.checked:Boolean(input.value));
    if(el.dataset.pub){if(['include','view','delivery','reason','method'].includes(el.dataset.pub))publication.change(el);return;}
    if(el.id==='ar-role'){const role=el.value,account=state.ops.accounts?.find(a=>a.id===({admin:'acct-admin',preparer:'acct-reviewer',reader:'acct-reader'}[role]));if(!account?.enabled){el.value=state.role;toast('This sample account is disabled. Choose an enabled account.');return;}guardNavigation(()=>{clearPrivateSession();state.ops.signedOut=false;state.role=role;render();});}
    else if(el.id==='ar-scenario'){const scenario=el.value;guardNavigation(()=>{state.scenario=scenario;render();});}
    else if(el.id==='ar-repo'){const repo=el.value;guardNavigation(()=>{saveRecordView();state.repo=enumParam(repo,['all','fixture','fork'],'all');state.id=null;state.queue=null;state.viewEpoch++;currentList().page=1;delete currentList().opener;syncRoute();render();});}
    else if(el.id==='ar-source-state'){currentList().source=el.value;currentList().page=1;render();}
    else if(el.id==='ar-report-completeness'){currentList().status=el.value;currentList().page=1;render();}
    else if(el.id==='ar-report-type'){currentList().type=el.value;currentList().page=1;render();}
    else if(el.id==='ar-report-delivery'){currentList().delivery=el.value;currentList().page=1;render();}
    else if(el.id==='ar-start-mode'){trackCoreInput(el);$('ar-start-sha-wrap').hidden=el.value!=='source';}
    else if(el.id==='ar-priority'){state.severity=el.value;state.findingPage=1;state.finding=0;render();}
    else if(el.id==='ar-finding-status'){state.findingStatus=el.value;state.findingPage=1;state.finding=0;render();}
    else if(el.id==='ar-finding-picker'){state.finding=intParam(el.value);render();}
    else if(el.id==='ar-selected-finding'){if(!can('action:prepare'))return;const id=item().id;state.selected[id]=el.checked?[...new Set([...(state.selected[id]||[]),state.finding])]:(state.selected[id]||[]).filter(f=>f!==state.finding);render();}
    else if(el.id==='ar-event-type'){state.eventType=el.value;render();}
    else if(el.id==='ar-attempt'){state.attempt=String(intParam(el.value,attemptCounts[item().id]||1,attemptCounts[item().id]||1));render();}
    else if(el.id==='ar-operation'){captureActionDraft();dialogDirty=true;operationOptions();}
    else if(trackCoreInput(el)){}
    else ops.change(el);
  });
  $('ar-dialog').addEventListener('cancel',e=>{e.preventDefault();if($('ar-dialog-title').textContent==='Leave unsaved changes?')handle('guard-stay');else handle('dialog-close');});
  document.addEventListener('keydown',e=>{if(state.page!=='login'&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if($('ar-dialog-title').textContent!=='Leave unsaved changes?'||!$('ar-dialog').open)guardNavigation(searchDialog);}else if(e.key==='Enter'&&!e.isComposing&&$('ar-dialog').open&&e.target.matches('input:not([type="checkbox"]):not([type="radio"])')&&!e.target.closest('form')){const submit={start:'start-submit',resume:'resume-submit',prepare:'prepare-submit',followup:'plan-prerequisites'}[coreForm?.kind]||(e.target.id==='ar-import-url'?'import-submit':null);if(submit){e.preventDefault();handle(submit,e.target);}}});
  window.addEventListener('popstate',e=>{
    if(historyTraversal){
      const transition=historyTraversal,position=e.state?.arPosition;
      if(transition.phase==='return'&&position===transition.from){
        historyTraversal=null;transition.returned=true;
        if(transition.approved&&!transition.cancelled){transition.phase='target';historyTraversal=transition;history.go(-transition.delta);}
        return;
      }
      if(transition.phase==='target'&&position===transition.to){historyTraversal=null;transition.apply();return;}
      // A different browser navigation supersedes this transfer; process its actual entry.
      transition.cancelled=true;historyTraversal=null;
    }
    const next=parseView(e.state?.ar?.hash||location.hash),position=Number.isInteger(e.state?.arPosition)?e.state.arPosition:routePosition,delta=routePosition-position,scroll=Number.isFinite(e.state?.arScroll)?Math.max(0,Math.min(10000000,e.state.arScroll)):0;
    const apply=()=>{const opener=e.state?.arViewEpoch===state.viewEpoch?listOpener(e.state?.arOpener,next.page):null;applyView(next,{queue:e.state?.arQueue,scroll,opener});routePosition=position;if($('ar-dialog').open)closeDialog();const restoreList=!state.id&&corePages.includes(state.page);render({deferFocus:restoreList});restoreScroll(scroll,{restoreList,opener});};
    if(state.dirty||dialogDirty){
      // Put the browser back on the visible route while the user decides.
      if(delta){
        const transition={phase:'return',from:routePosition,to:position,delta,apply,returned:false,approved:false,cancelled:false};historyTraversal=transition;history.go(delta);
        guardNavigation(()=>{transition.approved=true;if(transition.returned&&!transition.cancelled){transition.phase='target';historyTraversal=transition;history.go(-delta);}});
      }else{syncRoute(true);guardNavigation(()=>{apply();syncRoute(true);});}
    }else apply();
  });
  window.addEventListener('hashchange',()=>{
    if(historyTraversal||location.hash===routeSnapshot().hash)return;
    const next=parseView(location.hash),apply=()=>{applyView(next);if($('ar-dialog').open)closeDialog();syncRoute(true);render();restoreScroll();};
    if(state.dirty||dialogDirty){syncRoute(true);guardNavigation(apply);}else apply();
  });
  let scrollFramePending=false;
  window.addEventListener('scroll',()=>{if(scrollFramePending)return;scrollFramePending=true;requestAnimationFrame(()=>{scrollFramePending=false;const route=routeSnapshot();if(history.state?.ar?.hash===route.hash&&location.hash===route.hash){if(!state.id)currentList().scroll=window.scrollY;try{history.replaceState({...history.state,arScroll:Math.max(0,Math.min(10000000,window.scrollY))},'',route.hash);}catch{}}});},{passive:true});
  $('ar-prototype-settings').addEventListener('toggle',()=>{const settings=$('ar-prototype-settings'),trigger=root.querySelector('[data-action="prototype-settings"]');trigger.setAttribute('aria-expanded',String(settings.open));if(!settings.open&&settings.contains(document.activeElement))trigger.focus();});
  try {applyView(parseView(location.hash));}catch{}
  render();syncRoute(true);
  if(globalThis.Tweak){const tweak=new Tweak({container:root,onChange:render});tweak.addToggle(design,'compact',{label:'Compact source rows'});tweak.addToggle(design,'expanded',{label:'Expanded navigation labels'});tweak.addToggle(design,'validation',{label:'Validation column in lists'});}
})();
