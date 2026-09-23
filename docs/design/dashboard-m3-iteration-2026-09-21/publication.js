/* Finding-led publication study. All state, bindings and receipts are synthetic. */
function createPublicationWorkbench(ctx) {
  const {root,state,h,item,findings,feedbackFor,sourceKey,currentAccount,can,prepareReason,canExecute,fresh,pendingIntent,ownsIntent,openDialog,closeDialog,render,toast,originalCommit,legacySha}=ctx;
  const {esc,icon,button,badge,notice,field,select,dt}=h;
  const $=id=>root.querySelector('#'+id);
  function dialogError(message,id){ctx.dialogError(message,id);if(!id){const summary=$('ar-form-error');summary?.insertAdjacentHTML('beforeend',button('Review action choices','pub:choose','ghost small'));summary?.querySelector('button')?.focus();summary?.scrollIntoView({block:'nearest'});}}
  function showErrors(errors){for(const error of errors)ctx.dialogError(error.message,error.id);const summary=$('ar-form-error');if(summary?.querySelector('button')){summary.querySelector('button').focus();summary.scrollIntoView({block:'nearest'});}else if(errors[0])dialogError(errors[0].message);}
  const fieldId=(part,id)=>'ar-pub-'+part+(id===undefined?'':'-'+id);
  const labels={'request-changes':'Request changes',approve:'Approve',suggestion:'Review comments & suggestions',comment:'Conversation comment',close:'Close',merge:'Merge',ci:'Run CI',followup:'Run saved follow-up'};
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
    const d=state.publicationDrafts[key] ||= {mode:active,body:'',entries:{},reportSelectionBasis:reportSelectionKey(),q:'',view:'all',method:'Squash',reason:'not_planned',sha:item().type==='issues'?'':originalCommit,workflow:'validation.yml'};
    if(reviewModes.includes(active))for(const f of all())if(!d.entries[f.id]){const b=binding(f),text=feedbackFor(f);d.entries[f.id]={included:active!=='approve'&&(state.selected[item().id]||[]).includes(f.id),body:text,basis:text,reviewedBasis:text,delivery:active!=='comment'&&b.replacement?'suggestion':'summary',replacement:b.replacement||''};}
    return d;
  }
  function selected(d=draft()){return all().filter(f=>d.entries[f.id]?.included);}
  function importReportSelection(){const d=draft(),ids=reportSelection();all().forEach(f=>d.entries[f.id].included=ids.includes(f.id));d.reportSelectionBasis=reportSelectionKey();d.q='';d.view='all';}
  function redrawInPlace(draw,selector){const top=$('ar-dialog-body').scrollTop;draw();$('ar-dialog-body').scrollTop=top;const target=root.querySelector(selector);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
  function show(title,body,footer){openDialog(title,body,footer);$('ar-dialog').classList.add('ar-publish-dialog');$('ar-dialog-body').scrollTop=0;const first=Array.from($('ar-dialog-body').querySelectorAll('input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled),a[href]')).find(el=>el.getClientRects().length>0);first?.focus({preventScroll:true});}
  function sourceLine(){return `<p class="ar-publish-meta">${item().type==='issues'?'Issue':'PR'} #${item().number} · ${esc(item().repositoryFullName)} · ${sourceState()} · ${item().type==='issues'?'Imported Issue snapshot':'Head '+originalCommit.slice(0,7)}</p>`;}
  function currentGuard(op=active){return !fresh()?'Refresh current action guards before preparing.':state.scenario==='stale'?'The source changed. Re-import and review the current revision; your draft is retained.':sourceState()!=='Open'&&['request-changes','approve','suggestion','close','merge','followup'].includes(op)?'This synthetic source is '+sourceState().toLowerCase()+'. The saved report and private drafts remain available.':op==='followup'&&item().kind==='Feature'&&ctx.assessment().status==='needs_decision'?'The saved feature plan is a draft. Resolve the compatibility decisions and save an executable plan before starting implementation.':'';}
  function readiness(op=active){return prepareReason(op)||currentGuard(op)||(op==='approve'&&all().some(f=>f.priority==='P0'&&f.status==='Confirmed')?'Resolve the confirmed original P0 before approval.':'');}
  function stepper(n){return `<p class="ar-publish-mobile-step">Step ${n} of 3 · ${["Select findings","Compose","Preview"][n-1]}</p><ol class="ar-publish-stepper" aria-label="Publication steps">${['Select findings','Compose','Preview'].map((text,i)=>`<li ${n===i+1?'aria-current="step"':''}>${text}</li>`).join('')}</ol>`;}
  function summaryLine(){const rows=selected(),d=draft(),suggestions=rows.filter(f=>d.entries[f.id].delivery==='suggestion').length;return `${rows.length} selected · ${suggestions} suggested changes · ${rows.length-suggestions} text findings`;}
  function controlsFooter(nextText,nextAction){return button('Keep draft & close','pub:save')+button('Change action','pub:choose','ghost')+button(nextText,nextAction,'primary',prepareReason(active)||active==='request-changes'&&step===1&&!selected().length?'disabled':'');}
  function choose(options={}) {
    const pending=pendingIntent();if(pending){receipt(pending);return;}
    const issue=item().type==='issues';
    const choices=issue?[['comment','Conversation comment','Choose findings to share; edit the exact comment.'],['followup','Verify or implement a saved plan','Review the exact source and execution prerequisites.'],['close','Close issue','Choose the closure reason. Comments are a separate action.']]:[['request-changes','Request changes','Choose findings and optional code suggestions for one review.'],['approve','Approve','Accept the current revision; findings and summary are optional.'],['suggestion','Review comments & suggestions','Share code suggestions without approving or requesting changes.'],['comment','Conversation comment','Post text to the PR conversation; no inline code suggestions.'],['close','Close PR','Close without merging, commenting or deleting the branch.'],['merge','Merge PR','Review the merge method, head and current guards.'],['ci','Run CI','Choose a workflow and the source revision.'],['followup','Run saved validation','Use the saved plan with an exact commit.']];
    show(options.fromReport?'Publish selected findings':'Choose an action',sourceLine()+(options.fromReport?notice(reportSelection().length+' report findings will be used only if you choose a feedback action. Existing publishing text is kept.'):'')+`<p>${issue?'Share findings, continue investigation or close this Issue. Each action keeps its own draft.':'Review outcome and code suggestions are separate choices. A finding can include a suggested change in Request changes, Approve or a comment review.'}</p><div class="ar-publish-choices">${choices.map(([op,title,description])=>{const reason=readiness(op);return `<button type="button" class="ar-publish-choice" data-action="pub:${options.fromReport&&reviewModes.includes(op)?'from-report':'open'}:${op}" ${reason?'disabled':''}><strong>${esc(title)}</strong><span>${esc(description)}</span>${reason?`<span class="ar-small">${esc(reason)}</span>`:''}</button>`;}).join('')}</div>`,button('Close','dialog-close'));
  }
  function open(op,options={}) {
    if(!labels[op]||item().type==='issues'&&['request-changes','approve','suggestion','merge','ci'].includes(op))return;
    if(pendingIntent()){receipt(pendingIntent());return;}
    active=op;step=1;const d=draft();
    if(options.seed&&!d.body)d.body=options.seed;
    if(options.fromReport&&reviewModes.includes(op))importReportSelection();
    if(op==='followup'&&options.fromPlan){d.sha=legacySha()||'';d.sourceNote='Exact commit carried over from the plan you just reviewed.';}
    else if(op==='followup'&&!d.sha)d.sha=legacySha()||'';
    if(reviewModes.includes(op))selection();else operation();
  }
  function selection() {
    step=1;const d=draft(),rows=all().filter(f=>(d.view!=='selected'||d.entries[f.id].included)&&(f.id+' '+f.title+' '+f.path+' '+f.status).toLowerCase().includes(d.q.toLowerCase())),hidden=selected().filter(f=>!rows.some(row=>row.id===f.id)).length;
    const reason=prepareReason(active),guard=currentGuard();
    show(labels[active]+' · Choose findings',stepper(1)+sourceLine()+`<p class="ar-small ar-muted">${active==='approve'?'Findings are optional. Unchecking them does not resolve the saved assessment.':active==='comment'?'Text only. Choose a review action to share code suggestions.':'Choose findings for this action. Keeping this draft does not change report checkboxes.'}</p>`+(reason?notice(reason,'warning'):'')+(guard?notice(guard,'warning'):'')+(d.reportSelectionBasis!==reportSelectionKey()?notice('Report selection changed. This action still uses its own saved selection. '+button('Use report selection ('+reportSelection().length+')','pub:import-report','small')+button('Keep this draft selection','pub:keep-selection','ghost small'),'warning'):'')+`<div class="ar-toolbar" ${all().length<=8?'hidden':''}><div class="ar-search">${field('Search all findings','ar-pub-query',d.q,'search','data-pub="query"')}</div>${select('Show','ar-pub-view',[['all','All findings'],['selected','Selected findings']],d.view).replace('<select ','<select data-pub="view" ')}${button('Select visible ('+rows.length+')','pub:select-visible','small',reason?'disabled':'')}${button('Clear selection','pub:clear','ghost small',reason?'disabled':'')}</div><p id="ar-pub-count" class="ar-publish-summary" role="status">${selected().length} of ${all().length} selected${hidden?' · '+hidden+' selected hidden by this filter':''}</p><div>${rows.map(f=>{const e=d.entries[f.id],b=binding(f);return `<section class="ar-publish-card"><div class="ar-publish-card-head"><label class="ar-row"><input type="checkbox" data-pub="include" data-finding="${f.id}" aria-label="Include finding ${f.id}" ${e.included?'checked':''} ${reason?'disabled':''}><strong>${f.id}. ${esc(f.title)}</strong></label>${badge(f.priority,f.priority==='P0'?'error':'warning')}</div><p>${esc(f.status)} · ${esc(f.path)}</p><p class="ar-small">${b.replacement?(b.invalid?'Saved suggestion needs attention':'Saved code suggestion available · runtime not verified'):'Fix plan only · no applicable code suggestion'}</p><details><summary>Finding evidence and fix plan</summary><p>${esc(f.trigger)}</p><p>${esc(b.plan)}</p><pre class="ar-publish-code">${esc(f.excerpt)}</pre></details></section>`;}).join('')||'<p>No matching findings. Change the filter; existing selections are retained.</p>'}</div>`,controlsFooter(active==='request-changes'&&!selected().length?'Choose at least one finding':'Continue to compose','pub:compose'));
  }
  function entryEditor(f) {
    const d=draft(),e=d.entries[f.id],b=binding(f),changed=feedbackFor(f)!==e.reviewedBasis;
    return `<section class="ar-publish-card"><div class="ar-publish-card-head"><h3>${f.id}. ${esc(f.title)}</h3>${button('Remove','pub:remove:'+f.id,'ghost small','aria-label="Remove finding '+f.id+' from this publication"')}</div><p>${badge(f.priority,f.priority==='P0'?'error':'warning')} ${esc(f.status)}</p>${f.status==='Needs verification'?notice('Keep the uncertainty visible. Sending this finding does not confirm it.','warning'):''}${changed?notice('The report feedback changed after this publishing draft was created. '+button('Use latest feedback','pub:latest:'+f.id,'small')+button('Keep publishing text','pub:keep:'+f.id,'small'),'warning'):''}<label class="ar-field">Finding ${f.id} · publishing text<textarea id="${fieldId('text',f.id)}" aria-label="Finding ${f.id} · publishing text" data-pub="body" data-finding="${f.id}">${esc(e.body)}</textarea></label>${active==='comment'?'<p class="ar-small">Delivery: text in the conversation comment.</p>':`<label class="ar-field">Finding ${f.id} · delivery<select id="${fieldId('delivery',f.id)}" aria-label="Finding ${f.id} · delivery" data-pub="delivery" data-finding="${f.id}"><option value="summary" ${e.delivery==='summary'?'selected':''}>Text in review summary</option><option value="suggestion" ${e.delivery==='suggestion'?'selected':''} ${!b.replacement?'disabled':''}>GitHub suggested change${!b.replacement?' · no saved replacement':''}</option></select></label>`}${e.delivery==='suggestion'?`<div class="ar-publish-card-body"><p class="ar-publish-meta">${esc(b.path)} · RIGHT · lines ${b.startLine}–${b.endLine} · ${b.headSha.slice(0,7)}</p>${b.invalid?notice(esc(b.invalid)+' Choose summary text or remove this item; no automatic fallback.','error'):notice('The saved anchor matches this synthetic source. The code remains a proposed fix; runtime validation has not run.')}<details open><summary>Original code</summary><pre class="ar-publish-code">${esc(b.original)}</pre></details><label class="ar-field">Finding ${f.id} · replacement code<textarea id="${fieldId('replacement',f.id)}" aria-label="Finding ${f.id} · replacement code" class="ar-publish-code" data-pub="replacement" data-finding="${f.id}" spellcheck="false">${esc(e.replacement)}</textarea></label><p class="ar-small">GitHub will render a suggested change. Publishing it does not apply a commit.</p></div>`:`<p class="ar-small">${b.replacement?'Code suggestion omitted by your choice. The finding text will appear in the summary.':esc(b.plan)+' A prose fix plan cannot be applied as a GitHub suggestion.'}</p>`}</section>`;
  }
  function compose() {
    step=2;const d=draft(),rows=selected(),reason=prepareReason(active);
    show(labels[active]+' · Compose',stepper(2)+sourceLine()+`<p class="ar-publish-summary">${summaryLine()}</p>`+(reason?notice(reason,'warning'):'')+(currentGuard()?notice(currentGuard(),'warning'):'')+(lastReceipt(item(),active)?notice('This action has a recorded submission. Your private draft is retained for editing. '+button('View previous submission','pub:previous','small')):'')+(active==='approve'?notice('Approval accepts the reviewed revision. Saved findings and unrun validation remain visible; unresolved original P0 findings block approval.','warning'):'')+`<p class="ar-small">Edits are kept automatically for this session. Each action has its own summary and selection; report checkboxes stay unchanged.</p><label class="ar-field">${active==='comment'?'Conversation introduction':'Review summary'}${active==='approve'?' · optional':''}<textarea data-pub="summary" id="ar-pub-summary" aria-label="${active==='comment'?'Conversation introduction':'Review summary'}${active==='approve'?' · optional':''}">${esc(d.body)}</textarea></label><p class="ar-small">Selected findings below are included once. They are not automatically pasted into this summary field.</p>${rows.map(entryEditor).join('')||(active==='request-changes'?'<p>Choose at least one finding before requesting changes.</p>':'<p>No findings selected. This action will contain only your summary.</p>')}`,button('Back to findings','pub:selection')+button('Keep draft & close','pub:save')+button('Preview '+labels[active],'pub:preview','primary',reason||active==='request-changes'&&!rows.length?'disabled':''));
  }
  function validateReview() {
    const d=draft(),rows=selected(),errors=[],ranges=[];
    if(active==='request-changes'&&!rows.length)return [{message:'Choose at least one finding to request changes.'}];
    if(active==='approve'&&all().some(f=>f.priority==='P0'&&f.status==='Confirmed'))return [{message:'Approve is unavailable while the original PR has a confirmed unresolved P0. Unchecking it does not resolve it.'}];
    if(active==='comment'&&!d.body.trim()&&!rows.length)errors.push({message:'Write a comment or choose findings to include.',id:'ar-pub-summary'});
    if(active==='suggestion'&&!rows.some(f=>d.entries[f.id].delivery==='suggestion'))errors.push({message:'Choose at least one code suggestion, or switch to Conversation comment for text-only feedback.',id:rows.length?fieldId('delivery',rows[0].id):undefined});
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
    return {kind:'task',taskKind:item().kind==='Feature'?'feature-implement':item().type==='issues'?'issue-verify':'pr-verify',planRef:{id:'saved-validation-plan',version:1,digest:'0'.repeat(64)},sourceCommit:d.sha};
  }
  function operation() {
    step=2;const d=draft(),reason=readiness();let body='';
    if(active==='close')body=notice(item().type==='issues'?'Close this Issue with a reason. This does not verify or fix the reported behavior.':'Close this PR without merging or deleting its branch.','warning')+(item().type==='issues'?select('Issue closure reason','ar-pub-close-reason',[['completed','Completed'],['not_planned','Not planned']],d.reason).replace('<select ','<select data-pub="reason" '):'')+`<p>No comment, selected finding or suggested change will be sent by Close.</p><p class="ar-small">For a duplicate Issue, use a separately verified duplicate target; this fixture has no saved duplicate assessment.</p>${button('Prepare a separate comment first','pub:open:comment','ghost small')}`;
    if(active==='merge')body=notice('Merge updates the base branch. Review acceptance, required checks and mergeability use their independent current guards.','warning')+select('Merge method','ar-pub-merge-method',['Squash','Merge commit','Rebase'],d.method).replace('<select ','<select data-pub="method" ')+dt([['Base branch','main'],['Expected head',originalCommit],['Source review',ctx.assessment().label],['Runtime validation',item().validation],['Merge guards','Rechecked during authoritative preparation and execution']])+`<p>No review, finding comment or suggestion is sent as part of Merge.</p>`;
    if(active==='ci')body=field('Workflow file','ar-pub-workflow',d.workflow).replace('<input ','<input data-pub="workflow" ')+field('Exact source commit','ar-pub-sha',d.sha).replace('<input ','<input data-pub="sha" ')+notice('Dispatching a workflow queues a run. It does not establish a passed check.');
    if(active==='followup')body=dt([['Saved plan','saved-validation-plan'],['Assessment',ctx.assessment().label]])+field('Exact source commit','ar-pub-sha',d.sha).replace('<input ','<input data-pub="sha" ')+notice('Plan, source compatibility, execution permission and Worker admission are checked independently. A created Task is not a successful validation.');
    show(labels[active]+' · Prepare',sourceLine()+(reason?notice(reason,'warning'):'')+(d.sourceNote?notice(esc(d.sourceNote)):'')+body,button('Change action','pub:choose')+button('Keep draft & close','pub:save')+button('Preview '+labels[active],'pub:preview',active==='close'||active==='merge'?'danger':'primary',reason?'disabled':''));
  }
  function preview() {
    const reason=prepareReason(active)||currentGuard();if(reason){dialogError(reason);return;}
    const errors=reviewModes.includes(active)?validateReview():[];
    if(['ci','followup'].includes(active)&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(draft().sha))errors.push({message:'Enter a full 40- or 64-character source commit.',id:'ar-pub-sha'});
    if(active==='ci'){
      if(!/^[A-Za-z0-9_.-]+$/.test(draft().workflow))errors.push({message:'Enter a workflow filename using letters, numbers, dots, underscores or hyphens.',id:'ar-pub-workflow'});
      if(!errors.some(e=>e.id==='ar-pub-sha')&&draft().sha!==originalCommit)errors.push({message:'Use the exact reviewed PR commit '+originalCommit+'.',id:'ar-pub-sha'});
    }
    if(errors.length){showErrors(errors);return;}
    if(reviewModes.includes(active)){
      const wire=payload(),bytes=value=>new TextEncoder().encode(value).length,marker='<!-- agentic-review-action:intent-fixture-'+item().id+'-'+state.nextIntent+':'+'0'.repeat(64)+' -->';
      if(bytes([wire.body,...wire.drafts.filter(d=>!d.suggestion).map(d=>d.body),marker].filter(Boolean).join('\n\n'))>60000){
        const biggest=[{text:wire.body,id:'ar-pub-summary'},...wire.drafts.filter(d=>!d.suggestion).map(d=>({text:d.body,id:fieldId('text',d.id.split('-').pop())}))].sort((a,b)=>bytes(b.text)-bytes(a.text))[0];
        showErrors([{message:'The combined review summary is too large. Shorten this text or remove a selected finding.',id:biggest.id}]);return;
      }
      const large=wire.drafts.filter(d=>d.suggestion&&bytes(d.body+'\n\n```suggestion\n'+d.suggestion.replacement+'\n```')>60000);
      if(large.length){showErrors(large.map(d=>({message:'The full inline comment is too large. Shorten the publishing text or replacement code.',id:fieldId(bytes(d.body)>bytes(d.suggestion.replacement)?'text':'replacement',d.id.split('-').pop())})));return;}
    }
    if(pendingIntent()){receipt(pendingIntent());return;}
    const p={publisher:true,id:'intent-fixture-'+item().id+'-'+state.nextIntent++,actorId:currentAccount().id,itemId:item().id,sourceType:item().type==='issues'?'Issue':'PR',operation:active,status:'prepared',expectedHeadSha:item().type==='issues'?null:originalCommit,presentation:selected().map(f=>({id:'draft-'+item().id+'-'+f.id,findingId:f.id,title:f.title,assessment:f.status})),payload:JSON.parse(JSON.stringify(payload()))};
    state.actionIntents[sourceKey()]=p;state.preview=p;previewIntent(p);
  }
  function publicationBody(p) {
    const feedback=p.payload,entries=(feedback.drafts||[]).map(e=>({...e,...p.presentation?.find(f=>f.id===e.id)})),summary=entries.filter(e=>!e.suggestion),inline=entries.filter(e=>e.suggestion),reviewEvent={'request-changes':'REQUEST_CHANGES',approve:'APPROVE',suggestion:'COMMENT'}[p.operation];
    if(!reviewModes.includes(p.operation))return `<section class="ar-panel"><h3>Exact effect</h3><p>${p.operation==='close'?(p.sourceType==='Issue'?'Close Issue · '+({completed:'Completed',not_planned:'Not planned'}[feedback.reason]||feedback.reason):'Close PR without merging'):p.operation==='merge'?'Merge using '+({merge:'a merge commit',squash:'squash',rebase:'rebase'}[feedback.method]||feedback.method):p.operation==='ci'?'Queue workflow '+esc(feedback.workflowId):'Create follow-up Task for the saved plan'}</p><p>No finding feedback or code suggestion is included.</p>${['merge','ci','followup'].includes(p.operation)?`<p class="ar-publish-meta">Commit: ${esc(p.operation==='followup'?feedback.sourceCommit:p.operation==='ci'?feedback.ref:p.expectedHeadSha)}</p>`:''}</section>`;
    const text=[feedback.body,...summary.map(e=>e.body)].filter(Boolean).join('\n\n');
    return `<p class="ar-publish-summary">${entries.length} selected findings · ${inline.length} inline suggestions · ${summary.length} summary findings</p><p><strong>Destination:</strong> ${reviewEvent?'One GitHub review · '+reviewEvent:'One conversation comment'}</p><section class="ar-panel"><h3>${reviewEvent?'Review summary':'Conversation comment'}</h3><pre class="ar-publish-code">${esc(text||'(No summary text)')}</pre></section>${inline.map(e=>`<section class="ar-publish-preview-entry"><h3>Finding ${e.findingId} · ${esc(e.title)}</h3><p>${esc(e.assessment)} · ${esc(e.suggestion.path)}:${e.suggestion.startLine}–${e.suggestion.endLine}</p><p>${esc(e.body)}</p><pre class="ar-publish-code">${esc('```suggestion\n'+e.suggestion.replacement+'\n```')}</pre><p class="ar-small">Suggested change · author chooses whether to apply it · runtime not verified</p></section>`).join('')}<p class="ar-small">Only these selected findings will be published. Unselected findings and private report drafts are excluded.</p>`;
  }
  function previewIntent(p) {
    if(!ownsIntent(p)){receipt(p);return;}
    active=p.operation;step=3;const prior=lastReceipt(item(),p.operation),repeat=prior&&JSON.stringify(prior.payload)===JSON.stringify(p.payload),reason=!canExecute(p.operation)?'This account can prepare, but cannot execute this action with its current repository grants.':currentGuard(p.operation);
    show('Review publication preview',(reviewModes.includes(p.operation)?stepper(3):'')+sourceLine()+notice('Prepared only. Review the exact selected content before confirming.')+(repeat?notice('This is identical to your previous recorded submission '+esc(prior.id)+'. Confirming again creates another submission.','warning'):'')+publicationBody(p)+(reason?notice(reason,'warning'):'')+`<details><summary>Source binding and exact payload</summary><p>${esc(p.id)} · report-${p.itemId} v1 · ${p.sourceType==='PR'?originalCommit:'Imported Issue snapshot'}</p><pre class="ar-publish-code">${esc(JSON.stringify(p.payload,null,2))}</pre></details>`,button('Back to draft','pub:back')+button((repeat?'Confirm another ':'Confirm ')+labels[p.operation],'pub:confirm',p.operation==='close'||p.operation==='merge'?'danger':'primary',reason?'disabled':''));
  }
  function receipt(p,backToDraft=false) {
    if(!p)return;
    if(!ownsIntent(p)){show('Submission pending',notice('Another account has an unresolved submission for this source. Only its owner can inspect the payload or check the receipt.','warning'),button('Close','dialog-close'));return;}
    const unknown=p.status==='unknown',canCheck=canExecute(p.operation);
    show(unknown?'Publication result unknown':'Simulation receipt',sourceLine()+notice(unknown?'The result could not be confirmed. Keep this intent and check the existing submission; do not create another submission.':'Local simulation recorded. Nothing was sent to GitHub or a Worker.',unknown?'warning':'success')+dt([['Intent',esc(p.id)],['Action',labels[p.operation]],['Receipt level',(p.payload.drafts?.some(e=>e.suggestion)?'Review-level receipt; individual suggestions are not independently verified':'Operation-level receipt')]])+`<details><summary>${unknown?'Exact content of this submission':'Submitted content'}</summary>${publicationBody(p)}</details>`+(p.payload.drafts?.some(e=>e.suggestion)?notice('A review receipt does not prove that every suggestion was independently reconciled. No automatic retry of individual findings is offered.'):'')+(p.operation==='ci'&&unknown?notice('Workflow dispatch cannot be safely matched to this intent in the sample. Inspect the workflow run audit; checking does not authorize a resend.','warning'):'')+(p.operation==='close'&&unknown?notice('A closed source alone does not identify which request closed it. Check the closure audit on GitHub before resolving this intent.','warning'):'')+(p.result?.taskId?`<p>A separate follow-up is queued. The parent report has not changed.</p>${button('Open queued task','open:tasks:'+p.result.taskId,'primary')}`:'')+(unknown&&!canCheck?notice('This receipt remains readable. Checking and resolving it requires Execute actions and the original action capability.','warning'):'')+(p.operation==='comment'&&!unknown?`<p>The comment was recorded independently. Closing the source requires its own preview and confirmation.</p>${button('Prepare Close separately','pub:open:close','ghost small')}`:''),button('Close','dialog-close')+(backToDraft?button('Back to current draft','pub:resume-draft'):'')+(unknown?button('Check existing submission','pub:check','primary',!canCheck?'disabled':''):'')+(unknown&&p.operation==='close'?button('Open source on GitHub','pub:open-source','ghost'):'') );
  }
  function change(el) {
    const prop=el.dataset.pub;if(!prop)return false;if(!can('action:prepare'))return true;
    const d=draft(),id=Number(el.dataset.finding),e=d.entries[id];
    if(prop==='include'){const shown=Array.from(root.querySelectorAll('[data-pub="include"]')).map(input=>Number(input.dataset.finding)),at=shown.indexOf(id),top=$('ar-dialog-body').scrollTop;e.included=el.checked;selection();$('ar-dialog-body').scrollTop=top;const neighbor=shown[at+1]||shown[at-1],target=root.querySelector('[data-pub="include"][data-finding="'+id+'"]')||root.querySelector('[data-pub="include"][data-finding="'+neighbor+'"]')||$('ar-pub-view');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
    else if(prop==='query'){d.q=el.value;const pos=el.selectionStart;selection();$('ar-pub-query')?.focus();$('ar-pub-query')?.setSelectionRange(pos,pos);}
    else if(prop==='view'){d.view=el.value;redrawInPlace(selection,'#ar-pub-view');}
    else if(['body','replacement'].includes(prop))e[prop]=el.value;
    else if(prop==='delivery'){const top=$('ar-dialog-body').scrollTop;e.delivery=el.value;compose();$('ar-dialog-body').scrollTop=top;const target=root.querySelector('[data-pub="delivery"][data-finding="'+id+'"]');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
    else if(prop==='summary')d.body=el.value;
    else if(['reason','method','sha','workflow'].includes(prop))d[prop]=el.value;
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
    if(command==='save'){closeDialog();render();toast('Private publishing draft retained for this session. Nothing was sent.');return;}
    if(command==='open-source'){show('Check source on GitHub',h.githubLink(item())+notice('The source state alone does not prove this intent succeeded.'),button('Back to receipt','pub:check-view'));return;}
    if(command==='check-view'){receipt(pendingIntent());return;}
    if(command==='check'){
      const p=pendingIntent();if(!ownsIntent(p)||!canExecute(p.operation)){receipt(p);return;}if(['close','ci'].includes(p.operation)){receipt(p);toast((p.operation==='close'?'Closure':'Workflow dispatch')+' audit is unresolved in this sample. No request was resent.');return;}
      if(p.operation==='followup'){const task=ctx.createFollowup?.(p);if(!task){dialogError('The saved task binding could not be restored. The original intent is retained.');return;}p.result={taskId:task.id};}
      p.status='simulated';if(p.operation==='merge'){state.publicationSourceStates||={};state.publicationSourceStates[sourceKey()]='Merged';}state.scenario='normal';recordReceipt(p);render();receipt(p);return;
    }
    if(command!=='confirm'&&!can('action:prepare'))return;
    if(command==='import-report'){importReportSelection();selection();return;}
    if(command==='keep-selection'){draft().reportSelectionBasis=reportSelectionKey();selection();return;}
    if(command==='selection'){selection();return;}
    if(command==='compose'){if(active==='request-changes'&&!selected().length){dialogError('Choose at least one finding to request changes.');return;}compose();return;}
    if(command==='remove'){const ids=selected().map(f=>f.id),at=ids.indexOf(Number(arg)),next=ids[at+1]||ids[at-1];draft().entries[arg].included=false;redrawInPlace(compose,next?'#'+fieldId('text',next):'#ar-pub-summary');return;}
    if(command==='latest'||command==='keep'){const f=all().find(f=>f.id===Number(arg)),e=draft().entries[arg];if(command==='latest')e.body=feedbackFor(f);e.reviewedBasis=feedbackFor(f);redrawInPlace(compose,'#'+fieldId('text',f.id));return;}
    if(command==='select-visible'){const d=draft();all().filter(f=>(d.view!=='selected'||d.entries[f.id].included)&&(f.id+' '+f.title+' '+f.path+' '+f.status).toLowerCase().includes(d.q.toLowerCase())).forEach(f=>d.entries[f.id].included=true);selection();return;}
    if(command==='clear'){Object.values(draft().entries).forEach(e=>e.included=false);selection();return;}
    if(command==='preview'){preview();return;}
    if(command==='back'){reviewModes.includes(active)?compose():operation();return;}
    if(command==='confirm'){
      const p=state.preview;if(!p?.publisher||!ownsIntent(p)||p.status!=='prepared'||!canExecute(p.operation)||currentGuard(p.operation))return;
      if(state.scenario==='conflict'){p.status='conflict';show('Source or action guards changed',notice('The prepared action is no longer current. Your selected findings and edits are retained; check the current source before preparing again.','warning'),button('Return to draft','pub:back')+button('Close','dialog-close'));return;}
      if(state.scenario==='unknown')p.status='unknown';else {if(p.operation==='followup'){const task=ctx.createFollowup?.(p);if(!task){dialogError('A follow-up Task could not be created from this saved source and plan. Your prepared payload is retained.');return;}p.result={taskId:task.id};}p.status='simulated';if(['close','merge'].includes(p.operation)){state.publicationSourceStates||={};state.publicationSourceStates[sourceKey()]=p.operation==='close'?'Closed':'Merged';}}
      if(p.status==='simulated')recordReceipt(p);render();receipt(p);
    }
  }
  function findingCard(f){const b=binding(f);return `<div><h3>Proposed fix</h3><p>${esc(b.plan)}</p>${b.replacement?`<p>${badge(b.invalid?'Suggestion needs attention':'Code suggestion available',b.invalid?'warning':'info')}</p><p class="ar-small">Select this finding in a review to inspect and edit its saved replacement. Runtime validation has not run.</p>`:'<p class="ar-small">No saved replacement code. Publish as text, or generate a source-bound suggestion in a later investigation.</p>'}</div>`;}
  return {open,choose,handle,change,receipt,lastReceipt,previewIntent,findingCard,sourceState,sourceBlock:(x=item())=>sourceState(x)!=='Open'?'This source is '+sourceState(x).toLowerCase()+'.':''};
}
