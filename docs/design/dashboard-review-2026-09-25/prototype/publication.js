/* Finding-led publication study. All state, bindings and receipts are synthetic. */
function createPublicationWorkbench(ctx) {
  const {root,state,h,item,findings,feedbackFor,sourceKey,currentAccount,can,prepareReason,canExecute,fresh,pendingIntent,ownsIntent,openDialog,closeDialog,render,toast,originalCommit,legacySha}=ctx;
  const {esc,icon,button,badge,notice,field,select,dt}=h;
  const $=id=>root.querySelector('#'+id);
  function dialogError(message,id){ctx.dialogError(message,id);if(!id){const summary=$('ar-form-error');summary?.insertAdjacentHTML('beforeend',button('Review action choices','pub:choose','ghost small'));summary?.querySelector('button')?.focus();summary?.scrollIntoView({block:'nearest'});}}
  function showErrors(errors){for(const error of errors)ctx.dialogError(error.message,error.id);const summary=$('ar-form-error');if(summary?.querySelector('button')){summary.querySelector('button').focus();summary.scrollIntoView({block:'nearest'});}else if(errors[0])dialogError(errors[0].message);}
  const fieldId=(part,id)=>'ar-pub-'+part+(id===undefined?'':'-'+id);
  const labels={'request-changes':'Request changes',approve:'Approve',suggestion:'Code suggestions',comment:'Conversation comment',close:'Close',merge:'Merge',ci:'Run CI',followup:'Run saved plan'};
  const followupPlans={
    'pr-verify':{label:'PR verification',summary:'Check cancellation during Settings migration and verify the persisted configuration.'},
    'issue-verify':{label:'Issue verification',summary:'Reproduce the reported Settings startup failure and record the observed result.'},
    'feature-implement':{label:'Feature implementation',summary:'Implement selective export using the approved compatibility and dependency rules.'},
  };
  const followupKind=()=>item().kind==='Feature'?'feature-implement':item().type==='issues'?'issue-verify':'pr-verify';
  const reviewModes=['request-changes','approve','suggestion','comment'];
  let active='request-changes',step=1;
  const sourceState=(x=item())=>state.publicationSourceStates?.[sourceKey(x)]||'Open';
  function lastReceipt(x=item(),operation=null){return [...(state.publicationReceipts||[])].reverse().find(p=>p.itemId===x.id&&p.actorId===currentAccount()?.id&&(!operation||p.operation===operation))||null;}
  function recordReceipt(p){state.publicationReceipts||=[];if(!state.publicationReceipts.some(saved=>saved.id===p.id))state.publicationReceipts.push(JSON.parse(JSON.stringify(p)));}
  const all=()=>findings(item());
  const reportSelection=()=>[...new Set(state.selected[item().id]||[])].filter(id=>all().some(f=>f.id===id));
  const reportSelectionKey=()=>reportSelection().sort((a,b)=>a-b).join(',');
  function binding(f,x=item()) {
    if(x.type==='issues')return {plan:'Clarify or verify the reported behavior. This Issue snapshot has no PR diff anchor.'};
    if(!['2101','2102'].includes(x.id)||![1,2,5,26].includes(f.id))return {plan:'A fix requires further investigation. No saved replacement code is available.'};
    return {path:f.path.replace(/:\d+$/,''),startLine:f.id===26?126:42+(f.id-1)*3,endLine:f.id===26?127:43+(f.id-1)*3,side:'RIGHT',headSha:originalCommit,subjectRef:'original-pr-revision',originalContentDigest:'0'.repeat(64),original:f.excerpt,replacement:f.id===26?'await configuration.SaveAtomicallyAsync(nextSettings, cancellationToken);':'cancellationToken.ThrowIfCancellationRequested();\nawait configuration.SaveAsync(nextSettings, cancellationToken);',invalid:f.id===5?'Saved lines are outside the current diff. Re-import and review the source before using this suggestion.':'',plan:'Preserve the previous saved configuration when cancellation interrupts the update.'};
  }
  function draft() {
    state.publicationDrafts||={};const key=sourceKey()+':'+active;
    const d=state.publicationDrafts[key] ||= {mode:active,body:'',summarySource:'generated',entries:{},reportSelectionBasis:reportSelectionKey(),q:'',view:'all',method:'Squash',reason:'not_planned',sha:item().type==='issues'?'':originalCommit,workflow:'validation.yml'};
    if(reviewModes.includes(active))for(const f of all())if(!d.entries[f.id]){const b=binding(f),text=feedbackFor(f);d.entries[f.id]={included:active!=='approve'&&(state.selected[item().id]||[]).includes(f.id),body:text,basis:text,reviewedBasis:text,delivery:active!=='comment'&&b.replacement?'suggestion':'summary',replacement:b.replacement||''};}
    if(reviewModes.includes(active))syncSummary(d);
    return d;
  }
  function selected(d=draft()){return all().filter(f=>d.entries[f.id]?.included);}
  function generatedSummary(d) {
    const rows=selected(d),assessment=ctx.assessment(),ordered=[...rows].sort((a,b)=>Number(a.priority.slice(1))-Number(b.priority.slice(1)));
    const topics=[],patterns=[[/delet\w*.*(?:persist|saved|config)|remov\w*.*(?:persist|saved|config)/i,'configuration deletion'],[/cancel/i,'cancellation'],[/(?:stale|incomplete|persist|saved).*(?:settings|configuration)|(?:settings|configuration).*(?:stale|incomplete|persist|saved)/i,'configuration persistence'],[/keyboard/i,'keyboard navigation'],[/startup|start.up/i,'startup behavior'],[/compatib/i,'compatibility'],[/dependenc/i,'dependency rules']];
    for(const f of ordered){const text=f.title+' '+d.entries[f.id].body;for(const [pattern,label] of patterns)if(pattern.test(text)&&!topics.includes(label))topics.push(label);if(topics.length>=2)break;}
    const topic=topics.length?' affecting '+topics.slice(0,2).join(' and '):rows.length?' including “'+ordered[0].title.replace(/[.!?]+$/,'')+'”':'';
    const count=rows.length+' finding'+(rows.length===1?'':'s');
    let summary=active==='request-changes'?'Requesting changes for '+count+topic+'.':active==='suggestion'?'Sharing proposed code changes for '+count+topic+'.':active==='approve'?'Approving the reviewed revision'+(rows.length?' with feedback on '+count+topic:'')+'.':rows.length?'Sharing '+count+topic+'.':'Investigation summary: '+(assessment.rationale||item().title).split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/,'')+'.';
    const validation=assessment.validation||item().validation||'';
    if(/not run|pending|not recorded|blocked|in progress/i.test(validation)&&item().kind!=='Feature')summary+=' '+(item().type==='issues'?'Runtime reproduction':'Runtime validation')+(/blocked/i.test(validation)?' is blocked.':' is still pending.');
    return summary;
  }
  function syncSummary(d) {
    d.summarySource ||= d.body.trim()?'custom':'generated';
    d.generatedBody=generatedSummary(d);
    if(d.summarySource==='generated')d.body=d.generatedBody;
  }
  function importReportSelection(){const d=draft(),ids=reportSelection();all().forEach(f=>d.entries[f.id].included=ids.includes(f.id));d.reportSelectionBasis=reportSelectionKey();d.q='';d.view='all';}
  function redrawInPlace(draw,selector){const top=$('ar-dialog-body').scrollTop;draw();$('ar-dialog-body').scrollTop=top;const target=root.querySelector(selector);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
  function show(title,body,footer){openDialog(title,body,footer);$('ar-dialog').classList.add('ar-publish-dialog');$('ar-dialog-body').scrollTop=0;const first=Array.from($('ar-dialog-body').querySelectorAll('input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled),a[href]')).find(el=>el.getClientRects().length>0);first?.focus({preventScroll:true});}
  function sourceLine(){return `<p class="ar-publish-meta">${item().type==='issues'?'Issue':'PR'} #${item().number} · ${esc(item().repositoryFullName)} · ${sourceState()} · ${item().type==='issues'?'Imported Issue snapshot':'Head '+originalCommit.slice(0,7)}</p>`;}
  function currentGuard(op=active){return !fresh()?'Refresh current action guards before preparing.':state.scenario==='stale'?'Source changed. Re-import the current revision; your draft is kept.':sourceState()!=='Open'&&['request-changes','approve','suggestion','close','merge','followup'].includes(op)?'This source is '+sourceState().toLowerCase()+'.':op==='approve'&&all().some(f=>f.priority==='P0'&&f.status==='Confirmed')?'Resolve the confirmed original P0 before approval.':op==='followup'&&ctx.activeFollowup?.()?'A follow-up is already queued or running. Open its task to follow progress.':op==='followup'&&item().kind==='Feature'&&ctx.assessment().status==='needs_decision'?'Resolve the compatibility decisions and save an executable plan before implementation.':'';}
  function readiness(op=active){return prepareReason(op)||currentGuard(op)||(op==='suggestion'&&!all().some(f=>{const b=binding(f);return b.replacement&&!b.invalid;})?'No applicable code suggestion. Use Conversation comment for text feedback.':'');}
  function stepper(n){return `<p class="ar-publish-mobile-step">Step ${n} of 2 · ${['Select findings','Preview'][n-1]}</p><ol class="ar-publish-stepper" aria-label="Publication steps">${['Select findings','Preview'].map((text,i)=>`<li ${n===i+1?'aria-current="step"':''}>${text}</li>`).join('')}</ol>`;}
  function summaryLine(){const rows=selected(),d=draft(),suggestions=rows.filter(f=>d.entries[f.id].delivery==='suggestion').length;return `${rows.length} selected · ${suggestions} suggested changes · ${rows.length-suggestions} text findings`;}
  function controlsFooter(nextText,nextAction){return button('Save & close','pub:save')+button('Change action','pub:choose','ghost')+button(nextText,nextAction,'primary',prepareReason(active)||currentGuard()||['request-changes','suggestion'].includes(active)&&step===1&&!selected().length?'disabled':'');}
  function choose(options={}) {
    const pending=pendingIntent();if(pending){receipt(pending);return;}
    const issue=item().type==='issues',followup=ctx.activeFollowup?.();
    const choices=issue?[['comment','Conversation comment','Share selected findings as text.'],['followup','Run saved plan','Verify or implement against an exact commit.'],['close','Close issue','Choose a closure reason.']]:[['request-changes','Request changes','Request fixes, with optional code suggestions.'],['approve','Approve','Accept this revision; feedback is optional.'],['suggestion','Code suggestions','Share proposed code changes in a comment review.'],['comment','Conversation comment','Share text in the PR conversation.'],['close','Close PR','Close without merging or deleting the branch.'],['merge','Merge PR','Merge this revision into the base branch.'],['ci','Run CI','Queue a workflow for this revision.'],['followup','Run saved plan','Validate an exact commit.']];
    show(options.fromReport?'Publish selected findings':'Choose an action',sourceLine()+(options.fromReport?`<p class="ar-publish-summary">${reportSelection().length} selected findings</p>`:'')+(followup&&!options.fromReport?notice('Follow-up '+esc(followup.status.toLowerCase())+'. '+button('Open task','open:tasks:'+followup.id,'small')):'')+`<div class="ar-publish-choices">${choices.filter(([op])=>!options.fromReport||reviewModes.includes(op)).map(([op,title,description])=>{const reason=readiness(op);return `<button type="button" class="ar-publish-choice" data-action="pub:${options.fromReport?'from-report':'open'}:${op}" ${reason?'disabled':''}><strong>${esc(title)}</strong><span>${esc(description)}</span>${reason?`<span class="ar-small">${esc(reason)}</span>`:''}</button>`;}).join('')}</div>`,button('Close','dialog-close'));
  }
  function open(op,options={}) {
    if(!labels[op]||item().type==='issues'&&['request-changes','approve','suggestion','merge','ci'].includes(op))return;
    if(pendingIntent()){receipt(pendingIntent());return;}
    if(op==='followup'&&ctx.activeFollowup?.()){const task=ctx.activeFollowup();show('Follow-up already active',sourceLine()+notice('A follow-up is '+esc(task.status.toLowerCase())+'.'),button('Close','dialog-close')+button('Open task','open:tasks:'+task.id,'primary'));return;}
    active=op;step=1;const d=draft();
    if(options.seed&&(!d.body||d.summarySource==='generated')){d.body=options.seed;d.summarySource='custom';}
    if(options.fromReport&&reviewModes.includes(op))importReportSelection();
    if(op==='followup'&&options.fromPlan){d.sha=legacySha()||'';}
    else if(op==='followup'&&!d.sha)d.sha=legacySha()||'';
    if(reviewModes.includes(op))selection();else operation();
  }
  function selection() {
    step=1;const d=draft(),rows=all().filter(f=>(d.view!=='selected'||d.entries[f.id].included)&&(f.id+' '+f.title+' '+f.path+' '+f.status).toLowerCase().includes(d.q.toLowerCase())),hidden=selected().filter(f=>!rows.some(row=>row.id===f.id)).length;
    const reason=prepareReason(active),guard=currentGuard();
    const hint=active==='approve'?'Findings are optional. Approval accepts this revision.':active==='comment'?'Selected findings will be sent as text.':'';
    const filters=all().length>8?`<div class="ar-toolbar"><div class="ar-search">${field('Search findings','ar-pub-query',d.q,'search','data-pub="query"')}</div>${select('Show','ar-pub-view',[['all','All findings'],['selected','Selected findings']],d.view).replace('<select ','<select data-pub="view" ')}</div>`:'';
    const empty=all().length?`<p>No matching findings.</p>${button('Reset filters','pub:reset-filter','ghost small')}`:`<p class="ar-muted">No saved findings.${active==='comment'?' Preview the investigation summary.':active==='approve'?' You can approve without feedback.':''}</p>`;
    show(labels[active],stepper(1)+sourceLine()+(hint?`<p class="ar-small ar-muted">${hint}</p>`:'')+(reason?notice(reason,'warning'):'')+(guard?notice(guard,'warning'):'')+(d.reportSelectionBasis!==reportSelectionKey()?notice('Report selection changed. '+button('Use report selection ('+reportSelection().length+')','pub:import-report','small')+button('Keep this selection','pub:keep-selection','ghost small'),'warning'):'')+filters+`<div class="ar-row ar-publish-selection-tools"><p id="ar-pub-count" class="ar-publish-summary" role="status">${selected().length} of ${all().length} selected${hidden?' · '+hidden+' hidden by filter':''}</p><span class="ar-spacer"></span>${button('Select '+(all().length>8?'visible':'all'),'pub:select-visible','ghost small',reason||!rows.length||rows.every(f=>d.entries[f.id].included)?'disabled':'')}${button('Clear','pub:clear','ghost small',reason||!selected().length?'disabled aria-label="Clear selected findings"':'aria-label="Clear selected findings"')}</div><div>${rows.map(f=>{const e=d.entries[f.id],b=binding(f);return `<section class="ar-publish-card"><div class="ar-publish-card-head"><label class="ar-row ar-native-choice-label" for="ar-pub-include-${f.id}"><input type="checkbox" id="ar-pub-include-${f.id}" class="ar-native-choice" data-material-native data-pub="include" data-finding="${f.id}" aria-label="Include finding ${f.id}: ${esc(f.title)}" ${e.included?'checked':''} ${reason?'disabled':''}><strong>${f.id}. ${esc(f.title)}</strong></label>${badge(f.priority,f.priority==='P0'?'error':'warning')}</div><p class="ar-small ar-muted">${esc(f.status)} · ${esc(f.path)}</p>${active==='comment'?'':`<p class="ar-small">${b.replacement?(b.invalid?'Code suggestion · anchor needs review':'Code suggestion available'):'Text finding'}</p>`}<details><summary>Evidence & fix plan</summary><p>${esc(f.trigger)}</p><p>${esc(b.plan)}</p><pre class="ar-publish-code">${esc(f.excerpt)}</pre></details></section>`;}).join('')||empty}</div>`,controlsFooter('Preview','pub:preview'));
  }
  function entryEditor(f) {
    const d=draft(),e=d.entries[f.id],b=binding(f),changed=feedbackFor(f)!==e.reviewedBasis;
    const anchor=b.path&&b.headSha?esc(b.path)+' · RIGHT · lines '+b.startLine+'–'+b.endLine+' · '+b.headSha.slice(0,7):'No current source anchor';
    return `<section class="ar-publish-card"><div class="ar-publish-card-head"><h3>${f.id}. ${esc(f.title)}</h3>${button('Remove','pub:remove:'+f.id,'ghost small','aria-label="Remove finding '+f.id+' from this publication"')}</div><p>${badge(f.priority,f.priority==='P0'?'error':'warning')} ${esc(f.status)}</p>${changed?notice('Report feedback changed. '+button('Use latest text','pub:latest:'+f.id,'small')+button('Keep this text','pub:keep:'+f.id,'small'),'warning'):''}<label class="ar-field">Finding text<textarea id="${fieldId('text',f.id)}" aria-label="Finding ${f.id} · publishing text" data-pub="body" data-finding="${f.id}">${esc(e.body)}</textarea></label>${active==='comment'?'':`<label class="ar-field">Publish as<select id="${fieldId('delivery',f.id)}" aria-label="Finding ${f.id} · delivery" data-pub="delivery" data-finding="${f.id}"><option value="summary" ${e.delivery==='summary'?'selected':''}>Text in review summary</option><option value="suggestion" ${e.delivery==='suggestion'?'selected':''} ${!b.replacement?'disabled':''}>GitHub suggested change${!b.replacement?' · no saved code':''}</option></select></label>`}${e.delivery==='suggestion'?`<div class="ar-publish-card-body"><p class="ar-publish-meta">${anchor}</p>${b.invalid||!b.replacement?notice(esc(b.invalid||'No saved code suggestion is available.')+' Use summary text or remove this finding.','error'):''}<details><summary>Original code</summary><pre class="ar-publish-code">${esc(b.original||'No saved source range.')}</pre></details><label class="ar-field">Replacement code<textarea id="${fieldId('replacement',f.id)}" aria-label="Finding ${f.id} · replacement code" class="ar-publish-code" data-pub="replacement" data-finding="${f.id}" spellcheck="false">${esc(e.replacement)}</textarea></label></div>`:''}</section>`;
  }
  function compose() {
    step=0;const d=draft(),rows=selected(),reason=prepareReason(active);
    const hasSuggestions=rows.some(f=>d.entries[f.id].delivery==='suggestion'),summaryLabel=active==='comment'?'Comment introduction':'Review summary';
    show('Edit feedback · '+labels[active],sourceLine()+`<p class="ar-publish-summary">${summaryLine()}</p>`+(reason?notice(reason,'warning'):'')+(currentGuard()?notice(currentGuard(),'warning'):'')+(lastReceipt(item(),active)?notice('Previously submitted. '+button('View receipt','pub:previous','small')):'')+(active==='approve'?notice('Approval accepts this revision. Unresolved P0 findings block approval.','warning'):'')+`<div class="ar-row"><span class="ar-spacer"></span>${button('Use generated summary','pub:generated-summary','ghost small',d.summarySource==='generated'?'disabled':'')}</div><label class="ar-field">${summaryLabel}<textarea data-pub="summary" id="ar-pub-summary" aria-label="${summaryLabel}">${esc(d.body)}</textarea></label>`+(hasSuggestions?`<p class="ar-small ar-muted">Suggested code is unverified. Publishing proposes a change; it does not apply a commit.</p>`:'')+rows.map(entryEditor).join('')+(!rows.length&&active==='request-changes'?'<p>Choose at least one finding before requesting changes.</p>':''),button('Back to findings','pub:selection')+button('Save & close','pub:save')+button('Preview','pub:preview','primary',reason||currentGuard()||active==='request-changes'&&!rows.length?'disabled':''));
  }
  function reviewErrors(errors) {
    if(errors.some(error=>error.id))compose();else selection();
    showErrors(errors);
    const target=errors.map(error=>error.id&&$(error.id)).find(Boolean);
    target?.focus({preventScroll:true});target?.scrollIntoView({block:'center'});
  }
  function validateReview() {
    const d=draft(),rows=selected(),errors=[],ranges=[];
    if(active==='request-changes'&&!rows.length)return [{message:'Choose at least one finding to request changes.'}];
    if(active==='approve'&&all().some(f=>f.priority==='P0'&&f.status==='Confirmed'))return [{message:'Approve is unavailable while the original PR has a confirmed unresolved P0. Unchecking it does not resolve it.'}];
    if(!d.body.trim())errors.push({message:'Enter a summary or choose Use generated summary.',id:'ar-pub-summary'});
    if(active==='suggestion'&&!rows.some(f=>d.entries[f.id].delivery==='suggestion'))errors.push({message:'Choose at least one code suggestion, or switch to Conversation comment for text feedback.',id:rows.length?fieldId('delivery',rows[0].id):undefined});
    for(const f of rows){const e=d.entries[f.id],b=binding(f);
      if(!e.body.trim())errors.push({message:'Enter publishing text for finding '+f.id+'.',id:fieldId('text',f.id)});
      else if(feedbackFor(f)!==e.reviewedBasis)errors.push({message:'Review the changed report feedback for finding '+f.id+'. Use the latest feedback or explicitly keep your publishing text.',id:fieldId('text',f.id)});
      if(e.delivery!=='suggestion')continue;
      if(!b.replacement||b.invalid){errors.push({message:'Finding '+f.id+': '+(b.invalid||'No saved code suggestion is available.')+' Choose summary text or remove this finding.',id:fieldId('delivery',f.id)});continue;}
      if(new TextEncoder().encode(e.replacement).length>=60000||e.replacement.includes('```'))errors.push({message:'Finding '+f.id+' has an oversized replacement or a Markdown fence. Enter only replacement code.',id:fieldId('replacement',f.id)});
      else if(e.replacement===b.original)errors.push({message:'Finding '+f.id+' is unchanged. Edit the replacement or choose summary text.',id:fieldId('replacement',f.id)});
      if(ranges.some(r=>r.path===b.path&&b.startLine<=r.end&&b.endLine>=r.start))errors.push({message:'This suggestion overlaps another selected source range. Keep one replacement or publish this finding as summary text.',id:fieldId('delivery',f.id)});
      ranges.push({path:b.path,start:b.startLine,end:b.endLine});
    }
    if(ranges.length>100)errors.push({message:'A review can contain at most 100 code suggestions.'});
    return errors;
  }
  function payload() {
    const d=draft();
    if(reviewModes.includes(active))return {kind:'feedback',body:d.body,findingIds:selected().map(f=>'finding-'+item().id+'-'+f.id),drafts:selected().map(f=>{const e=d.entries[f.id],b=binding(f);return {id:'draft-'+item().id+'-'+f.id,body:e.delivery==='suggestion'?e.body:'### Finding '+f.id+' · '+f.title+'\n\n'+e.body,suggestion:e.delivery==='suggestion'?{subjectRef:b.subjectRef,path:b.path,startLine:b.startLine,endLine:b.endLine,headSha:b.headSha,originalContentDigest:b.originalContentDigest,replacement:e.replacement}:null};})};
    if(active==='close')return {kind:'close',reason:item().type==='issues'?d.reason:'not_planned',duplicateNumber:null};
    if(active==='merge')return {kind:'merge',method:{Squash:'squash','Merge commit':'merge',Rebase:'rebase'}[d.method],commitTitle:''};
    if(active==='ci')return {kind:'trigger-ci',workflowId:d.workflow,ref:d.sha,inputs:{}};
    return {kind:'task',taskKind:followupKind(),planRef:{id:'saved-validation-plan',version:1,digest:'0'.repeat(64)},sourceCommit:d.sha};
  }
  function operation() {
    step=2;const d=draft(),reason=readiness();let body='';
    if(active==='close')body=notice(item().type==='issues'?'Close this Issue. Closure does not establish that it was verified or fixed.':'Close this PR without merging or deleting its branch.','warning')+(item().type==='issues'?select('Closure reason','ar-pub-close-reason',[['completed','Completed'],['not_planned','Not planned']],d.reason).replace('<select ','<select data-pub="reason" '):'')+`<p class="ar-small ar-muted">No comment will be sent.</p>${button('Write a comment first','pub:open:comment','ghost small')}`;
    if(active==='merge')body=notice('Merge updates the base branch. Required checks and mergeability must pass.','warning')+select('Merge method','ar-pub-merge-method',['Squash','Merge commit','Rebase'],d.method).replace('<select ','<select data-pub="method" ')+dt([['Base branch','main'],['Expected head',originalCommit],['Source review',ctx.assessment().label],['Runtime validation',item().validation],['Merge guards','Rechecked before execution']]);
    if(active==='ci')body=field('Workflow file','ar-pub-workflow',d.workflow).replace('<input ','<input data-pub="workflow" ')+field('Exact source commit','ar-pub-sha',d.sha).replace('<input ','<input data-pub="sha" ')+`<p class="ar-small ar-muted">Queues a workflow run; results arrive separately.</p>`;
    if(active==='followup'){const plan=followupPlans[followupKind()];body=`<section class="ar-panel"><h3>${esc(plan.label)}</h3><p>${esc(plan.summary)}</p></section>`+dt([['Assessment',ctx.assessment().label]])+field('Exact source commit','ar-pub-sha',d.sha).replace('<input ','<input data-pub="sha" ')+`<p class="ar-small ar-muted">Requires compatible source, execution permission and Worker admission.</p>`;}
    show(labels[active],sourceLine()+(reason?notice(reason,'warning'):'')+body,button('Change action','pub:choose')+button('Save & close','pub:save')+button('Preview','pub:preview','primary',reason?'disabled':''));
  }
  function preview() {
    const reason=prepareReason(active)||currentGuard();if(reason){dialogError(reason);return;}
    if(['ci','followup'].includes(active)){draft().sha=draft().sha.trim();draft().workflow=draft().workflow.trim();if(active==='followup')ctx.setLegacySha?.(draft().sha);}
    const errors=reviewModes.includes(active)?validateReview():[];
    if(['ci','followup'].includes(active)&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(draft().sha))errors.push({message:'Enter a full 40- or 64-character source commit.',id:'ar-pub-sha'});
    if(active==='ci'){
      if(!/^[A-Za-z0-9_.-]+$/.test(draft().workflow))errors.push({message:'Enter a workflow filename using letters, numbers, dots, underscores or hyphens.',id:'ar-pub-workflow'});
      if(!errors.some(e=>e.id==='ar-pub-sha')&&draft().sha!==originalCommit)errors.push({message:'Use the exact reviewed PR commit '+originalCommit+'.',id:'ar-pub-sha'});
    }
    if(errors.length){reviewModes.includes(active)?reviewErrors(errors):showErrors(errors);return;}
    const preparedPayload=payload();
    if(reviewModes.includes(active)){
      const wire=preparedPayload,bytes=value=>new TextEncoder().encode(value).length,marker='<!-- agentic-review-action:intent-fixture-'+item().id+'-'+state.nextIntent+':'+'0'.repeat(64)+' -->';
      if(bytes([wire.body,...wire.drafts.filter(d=>!d.suggestion).map(d=>d.body),marker].filter(Boolean).join('\n\n'))>60000){
        const biggest=[{text:wire.body,id:'ar-pub-summary'},...wire.drafts.filter(d=>!d.suggestion).map(d=>({text:d.body,id:fieldId('text',d.id.split('-').pop())}))].sort((a,b)=>bytes(b.text)-bytes(a.text))[0];
        reviewErrors([{message:'The combined review summary is too large. Shorten this text or remove a selected finding.',id:biggest.id}]);return;
      }
      const large=wire.drafts.filter(d=>d.suggestion&&bytes(d.body+'\n\n```suggestion\n'+d.suggestion.replacement+'\n```')>60000);
      if(large.length){reviewErrors(large.map(d=>({message:'The full inline comment is too large. Shorten the publishing text or replacement code.',id:fieldId(bytes(d.body)>bytes(d.suggestion.replacement)?'text':'replacement',d.id.split('-').pop())})));return;}
    }
    if(pendingIntent()){receipt(pendingIntent());return;}
    const p={publisher:true,id:'intent-fixture-'+item().id+'-'+state.nextIntent++,actorId:currentAccount().id,itemId:item().id,sourceType:item().type==='issues'?'Issue':'PR',operation:active,status:'prepared',expectedHeadSha:item().type==='issues'?null:originalCommit,presentation:selected().map(f=>({id:'draft-'+item().id+'-'+f.id,findingId:f.id,title:f.title,assessment:f.status})),payload:JSON.parse(JSON.stringify(preparedPayload))};
    state.actionIntents[sourceKey()]=p;state.preview=p;previewIntent(p);
  }
  function publicationBody(p) {
    const feedback=p.payload,entries=(feedback.drafts||[]).map(e=>({...e,...p.presentation?.find(f=>f.id===e.id)})),summary=entries.filter(e=>!e.suggestion),inline=entries.filter(e=>e.suggestion),reviewEvent={'request-changes':'REQUEST_CHANGES',approve:'APPROVE',suggestion:'COMMENT'}[p.operation];
    const plan=followupPlans[feedback.taskKind];
    if(!reviewModes.includes(p.operation))return `<section class="ar-panel"><h3>${p.operation==='followup'?esc(plan?.label||'Follow-up task'):'Action'}</h3><p>${p.operation==='close'?(p.sourceType==='Issue'?'Close Issue · '+({completed:'Completed',not_planned:'Not planned'}[feedback.reason]||feedback.reason):'Close PR without merging or deleting its branch'):p.operation==='merge'?'Merge into main using '+({merge:'a merge commit',squash:'squash',rebase:'rebase'}[feedback.method]||feedback.method):p.operation==='ci'?'Queue workflow '+esc(feedback.workflowId):esc(plan?.summary||'Run the saved plan.')}</p>${p.operation==='close'?'<p class="ar-small ar-muted">No comment will be sent.</p>':p.operation==='followup'?'<p class="ar-small ar-muted">Creates a queued task. Execution results arrive separately.</p>':''}${['merge','ci','followup'].includes(p.operation)?`<p class="ar-publish-meta">Commit: ${esc(p.operation==='followup'?feedback.sourceCommit:p.operation==='ci'?feedback.ref:p.expectedHeadSha)}</p>`:''}</section>`;
    return `<p class="ar-publish-summary">${entries.length} selected · ${inline.length} code suggestions · ${summary.length} text findings</p><p><strong>Destination:</strong> ${reviewEvent?'One GitHub review · '+reviewEvent:'One conversation comment'}</p><section class="ar-panel"><h3>${reviewEvent?'Review summary':'Conversation comment'}</h3><p class="ar-publish-prose">${esc(feedback.body)}</p>${summary.map(e=>`<pre class="ar-publish-prose">${esc(e.body)}</pre>`).join('')}</section>${inline.length?'<p class="ar-small ar-muted">Proposed code changes · runtime unverified · no commit applied by publishing</p>':''}${inline.map(e=>`<section class="ar-publish-preview-entry"><h3>Finding ${e.findingId} · ${esc(e.title)}</h3><p>${esc(e.assessment)} · ${esc(e.suggestion.path)}:${e.suggestion.startLine}–${e.suggestion.endLine}</p><p>${esc(e.body)}</p><pre class="ar-publish-code">${esc('```suggestion\n'+e.suggestion.replacement+'\n```')}</pre></section>`).join('')}`;
  }
  function previewIntent(p) {
    if(!ownsIntent(p)){receipt(p);return;}
    if(p.status!=='prepared'){receipt(p);return;}
    active=p.operation;step=2;const prior=lastReceipt(item(),p.operation),repeat=prior&&JSON.stringify(prior.payload)===JSON.stringify(p.payload),reason=!canExecute(p.operation)?'This account can prepare, but cannot execute this action with its current repository grants.':currentGuard(p.operation);
    show('Preview · '+labels[p.operation],(reviewModes.includes(p.operation)?stepper(2):'')+sourceLine()+(repeat?notice('This matches your previous submission. Confirming creates a duplicate.','warning'):'')+publicationBody(p)+(reason?notice(reason,'warning'):'')+`<details><summary>Source & payload details</summary><p>${esc(p.id)} · report-${p.itemId} v1 · ${p.sourceType==='PR'?originalCommit:'Imported Issue snapshot'}</p><pre class="ar-publish-code">${esc(JSON.stringify(p.payload,null,2))}</pre></details>`,button(reviewModes.includes(p.operation)?'Back to findings':'Back to draft','pub:back')+(reviewModes.includes(p.operation)?button('Edit feedback','pub:compose','ghost'):'')+button((repeat?'Confirm another ':'Confirm ')+labels[p.operation],'pub:confirm',p.operation==='close'||p.operation==='merge'?'danger':'primary',reason?'disabled':''));
  }
  function receipt(p,backToDraft=false) {
    if(!p)return;
    if(!ownsIntent(p)){show('Submission pending',notice('Another account has an unresolved submission for this source. Only its owner can inspect the payload or check the receipt.','warning'),button('Close','dialog-close'));return;}
    active=p.operation;
    if(p.status==='conflict'){show('Source changed',sourceLine()+notice('The prepared action is out of date. Your draft is kept; review the current source before preparing again.','warning'),button('Close','dialog-close')+button('Back to draft','pub:back','primary'));return;}
    const unknown=p.status==='unknown',canCheck=canExecute(p.operation),hasSuggestions=p.payload.drafts?.some(e=>e.suggestion);
    const audit=unknown&&p.operation==='ci'?'Requires a workflow run audit; automatic matching is unavailable.':unknown&&p.operation==='close'?'Requires a closure audit; source state alone cannot confirm this request.':'';
    show(unknown?'Result unknown':'Simulation receipt',sourceLine()+notice(unknown?'Result unconfirmed. Check this submission before another action. Do not resend.':'Recorded locally. Nothing was sent to GitHub or a Worker.',unknown?'warning':'success')+dt([['Action',labels[p.operation]],...(p.result?.taskId?[['Follow-up','Queued · no execution result yet']]:[])])+(audit?`<p class="ar-small">${audit}</p>`:'')+(unknown&&p.checked?'<p class="ar-small" role="status">Still unconfirmed · No request resent.</p>':'')+(unknown&&!canCheck?notice('Checking requires Execute actions permission and the original action capability.','warning'):'')+`<details><summary>Submission details</summary>${dt([['Intent',esc(p.id)],['Receipt',hasSuggestions?'Review level; individual suggestions are not independently verified':'Operation level']])}${publicationBody(p)}</details>`,button(unknown?'Close':'Done','dialog-close',!unknown&&!p.result?.taskId&&!backToDraft?'primary':'')+(backToDraft?button('Back to draft','pub:resume-draft','primary'):'')+(p.result?.taskId?button('Open queued task','open:tasks:'+p.result.taskId,'primary'):'')+(unknown?button('Check existing submission','pub:check','primary',!canCheck?'disabled':''):'')+(unknown&&p.operation==='close'?button('Open source on GitHub','pub:open-source','ghost'):'') );
  }
  function change(el) {
    const prop=el.dataset.pub;if(!prop)return false;if(!can('action:prepare'))return true;
    const d=draft(),id=Number(el.dataset.finding),e=d.entries[id];
    if(prop==='include'){const shown=Array.from(root.querySelectorAll('[data-pub="include"]')).map(input=>Number(input.dataset.finding)),at=shown.indexOf(id),top=$('ar-dialog-body').scrollTop;e.included=el.checked;selection();$('ar-dialog-body').scrollTop=top;const neighbor=shown[at+1]||shown[at-1],target=root.querySelector('[data-pub="include"][data-finding="'+id+'"]')||root.querySelector('[data-pub="include"][data-finding="'+neighbor+'"]')||$('ar-pub-view');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
    else if(prop==='query'){d.q=el.value;const pos=el.selectionStart;selection();$('ar-pub-query')?.focus();$('ar-pub-query')?.setSelectionRange(pos,pos);}
    else if(prop==='view'){d.view=el.value;redrawInPlace(selection,'#ar-pub-view');}
    else if(['body','replacement'].includes(prop)){e[prop]=el.value;if(prop==='body'&&d.summarySource==='generated'){syncSummary(d);if($('ar-pub-summary'))$('ar-pub-summary').value=d.body;}}
    else if(prop==='delivery'){const top=$('ar-dialog-body').scrollTop;e.delivery=el.value;compose();$('ar-dialog-body').scrollTop=top;const target=root.querySelector('[data-pub="delivery"][data-finding="'+id+'"]');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
    else if(prop==='summary'){d.body=el.value;d.summarySource='custom';const reset=root.querySelector('[data-action="pub:generated-summary"]');if(reset)reset.disabled=false;}
    else if(['reason','method','sha','workflow'].includes(prop)){d[prop]=el.value;if(prop==='sha'&&active==='followup')ctx.setLegacySha?.(el.value);}
    return true;
  }
  function handle(action) {
    const [,command,arg]=action.split(':');
    if(command==='choose'){choose();return;}
    if(command==='previous'){receipt(lastReceipt(item(),active),true);return;}
    if(command==='resume-draft'){reviewModes.includes(active)?compose():operation();return;}
    if(command==='choose-report'){choose({fromReport:true});return;}
    if(command==='open'){open(arg);return;}
    if(command==='from-report'){open(arg,{fromReport:true});return;}
    if(command==='from-plan'){open('followup',{fromPlan:true});return;}
    if(command==='save'){closeDialog();render();toast('Draft saved for this session.');return;}
    if(command==='open-source'){show('Check source on GitHub',h.githubLink(item())+notice('The source state alone does not prove this intent succeeded.'),button('Back to receipt','pub:check-view'));return;}
    if(command==='check-view'){receipt(pendingIntent());return;}
    if(command==='check'){
      const p=pendingIntent();if(!ownsIntent(p)||!canExecute(p.operation)){receipt(p);return;}if(['close','ci'].includes(p.operation)){p.checked=true;receipt(p);toast('Still unconfirmed. No request resent.');return;}
      if(p.operation==='followup'){const task=ctx.createFollowup?.(p);if(!task){dialogError('The saved task binding could not be restored. The original intent is retained.');return;}p.result={taskId:task.id};}
      p.status='simulated';if(p.operation==='merge'){state.publicationSourceStates||={};state.publicationSourceStates[sourceKey()]='Merged';}state.scenario='normal';recordReceipt(p);render();receipt(p);return;
    }
    if(command!=='confirm'&&!can('action:prepare'))return;
    if(command==='import-report'){importReportSelection();selection();return;}
    if(command==='keep-selection'){draft().reportSelectionBasis=reportSelectionKey();selection();return;}
    if(command==='reset-filter'){draft().q='';draft().view='all';selection();return;}
    if(command==='selection'){selection();return;}
    if(command==='compose'){if(active==='request-changes'&&!selected().length){dialogError('Choose at least one finding to request changes.');return;}compose();return;}
    if(command==='generated-summary'){const d=draft();d.summarySource='generated';syncSummary(d);redrawInPlace(compose,'#ar-pub-summary');return;}
    if(command==='remove'){const ids=selected().map(f=>f.id),at=ids.indexOf(Number(arg)),next=ids[at+1]||ids[at-1];draft().entries[arg].included=false;redrawInPlace(compose,next?'#'+fieldId('text',next):'#ar-pub-summary');return;}
    if(command==='latest'||command==='keep'){const f=all().find(f=>f.id===Number(arg)),e=draft().entries[arg];if(command==='latest')e.body=feedbackFor(f);e.reviewedBasis=feedbackFor(f);redrawInPlace(compose,'#'+fieldId('text',f.id));return;}
    if(command==='select-visible'){const d=draft();all().filter(f=>(d.view!=='selected'||d.entries[f.id].included)&&(f.id+' '+f.title+' '+f.path+' '+f.status).toLowerCase().includes(d.q.toLowerCase())).forEach(f=>d.entries[f.id].included=true);selection();return;}
    if(command==='clear'){Object.values(draft().entries).forEach(e=>e.included=false);selection();return;}
    if(command==='preview'){preview();return;}
    if(command==='back'){reviewModes.includes(active)?selection():operation();return;}
    if(command==='confirm'){
      const p=state.preview;if(!p?.publisher||!ownsIntent(p))return;if(p.status!=='prepared'){receipt(p);return;}
      const reason=!canExecute(p.operation)?'Execute actions permission is required.':currentGuard(p.operation);if(reason){dialogError(reason);return;}
      if(state.scenario==='conflict'){p.status='conflict';show('Source or action guards changed',notice('The prepared action is no longer current. Your selected findings and edits are retained; check the current source before preparing again.','warning'),button('Return to draft','pub:back')+button('Close','dialog-close'));return;}
      if(state.scenario==='unknown')p.status='unknown';else {if(p.operation==='followup'){const task=ctx.createFollowup?.(p);if(!task){dialogError('A follow-up Task could not be created from this saved source and plan. Your prepared payload is retained.');return;}p.result={taskId:task.id};}p.status='simulated';if(['close','merge'].includes(p.operation)){state.publicationSourceStates||={};state.publicationSourceStates[sourceKey()]=p.operation==='close'?'Closed':'Merged';}}
      if(p.status==='simulated')recordReceipt(p);render();receipt(p);
    }
  }
  function findingCard(f){const b=binding(f);return `<div><h3>Proposed fix</h3><p>${esc(b.plan)}</p>${b.replacement?`<p>${badge(b.invalid?'Suggestion needs attention':'Code suggestion available',b.invalid?'warning':'info')}</p><p class="ar-small ar-muted">Runtime unverified.</p>`:''}</div>`;}
  return {open,choose,handle,change,receipt,lastReceipt,previewIntent,findingCard,sourceState,sourceBlock:(x=item())=>sourceState(x)!=='Open'?'This source is '+sourceState(x).toLowerCase()+'.':''};
}
