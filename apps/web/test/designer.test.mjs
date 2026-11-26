import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {setImmediate} from 'node:timers/promises';
import {designerScript,designerMarkup,workspaceSourcesMarkup,workspaceRail} from '../dist/workspace-designer.js';
function setup(){
 const els=new Map();const elements=(selector)=>nodes[selector]||[];const nodes={};let requests=[];let payload={version:0,connectionId:'c',nodes:[{externalGroupId:'g',fullPath:'acme',x:80,y:80,repositories:[{externalProjectId:'p',pathWithNamespace:'acme/api',branch:'main'}]}]};let failure=false;let selected;let pendingSave=null;let releaseSave;let pendingLoad=null;let releaseLoad;let loadError=false;let directoryPages=1;
 function el(id){if(!els.has(id))els.set(id,{id,value:'',hidden:false,disabled:false,textContent:'',style:{},dataset:{},listeners:{},classList:{toggle(){}},setAttribute(k,v){this[k]=v},addEventListener(e,cb){(this.listeners[e]??=[]).push(cb)},click(){for(const cb of [...(this.listeners.click||[])])cb.call(this,{})},change(v){this.value=v;for(const cb of [...(this.listeners.change||[])])cb.call(this,{})},get innerHTML(){return this.html||''},set innerHTML(v){this.html=v;const configs={ 'repository-nodes':['[data-node]',/data-node="([^"]+)"/g,'node'],'workspace-choices':['[data-workspace-choice]',/data-workspace-choice="([^"]+)"/g,'workspaceChoice'],'repository-projects':['[data-project-branch]',/data-project-branch="([^"]+)"/g,'projectBranch']};if(configs[id]){const [selector,regex,key]=configs[id];nodes[selector]=[...v.matchAll(regex)].map((m)=>{els.delete(id+'-'+m[1]);const e=el(id+'-'+m[1]);e.dataset[key]=m[1];return e})}}});return els.get(id)}
 for(const m of (designerMarkup+workspaceSourcesMarkup+workspaceRail).matchAll(/id="([^"]+)"/g))el(m[1]);
 const context={document:{getElementById:el,querySelectorAll:elements},esc:(x)=>String(x??'').replaceAll('<','&lt;'),fetch:async(url,options)=>{requests.push({url,options});let data;if(url.includes('/repository-groups')){if(!options){if(pendingLoad)await pendingLoad;if(loadError)return {ok:false,json:async()=>({message:'load failed'})}}if(options?.method==='PUT'){if(pendingSave)await pendingSave;if(failure)return {ok:false,json:async()=>({message:'conflict'})};const body=JSON.parse(options.body);payload={...payload,version:payload.version+1,nodes:body.nodes};}data=payload;}else if(url.includes('/repository-catalog'))data={items:[{id:'p',pathWithNamespace:'acme/api',defaultBranch:'main'}]};else if(url.includes('/repository-branches'))data={items:[{name:'main'},{name:'branch-'+new URL(url,'http://local').searchParams.get('page')}],nextPage:Number(new URL(url,'http://local').searchParams.get('page'))<directoryPages?Number(new URL(url,'http://local').searchParams.get('page'))+1:null};else {const page=Number(new URL(url,'http://local').searchParams.get('page'));data={items:[{id:'g',fullPath:'acme'},{id:'g2',fullPath:'second'},{id:'group-'+page,fullPath:'group-'+page}],nextPage:page<directoryPages?page+1:null}};return {ok:true,json:async()=>JSON.parse(JSON.stringify(data))}}};
 runInNewContext(designerScript+'; var instance=createWorkspaceDesigner({onSelect:function(id){picked=id},onNew:function(){newCalls++}})',Object.assign(context,{picked:'',newCalls:0}));
 return {ui:context.instance,el,elements,context,get requests(){return requests},set failure(v){failure=v},set payload(v){payload=v},deferSave(){pendingSave=new Promise(resolve=>{releaseSave=resolve})},finishSave(){releaseSave();pendingSave=null},deferLoad(){pendingLoad=new Promise(resolve=>{releaseLoad=resolve})},finishLoad(){releaseLoad();pendingLoad=null},set loadError(v){loadError=v},set directoryPages(v){directoryPages=v}};
}
test('workspaces rail selects details and designer edits multiple Group nodes with saved branches',async()=>{
 const f=setup();f.ui.render({workspaces:[{id:'w',group:'acme',status:'READY',repositories:[]},{id:'broken',group:'broken',status:'FAILED',repositories:[]}]},'w');await setImmediate();
 assert.match(f.el('workspace-choices').innerHTML,/需要检查/);f.elements('[data-workspace-choice]')[1].click();assert.equal(f.context.picked,'broken');
 f.el('rail-new-workspace').click();assert.equal(f.context.newCalls,1);
 f.el('workspace-tab-designer').click();await setImmediate();assert.equal(f.el('workspace-designer').hidden,false);
 f.elements('[data-node]')[0].click();await setImmediate();assert.equal(f.el('repository-editor').hidden,false);
 const branch=f.elements('[data-project-branch]')[0];branch.change('staging');assert.equal(f.ui.inspect().nodes[0].repositories[0].branch,'staging');assert.equal(f.ui.isDirty(),true);
 f.ui.render({workspaces:[{id:'w',group:'acme',status:'READY',repositories:[]}]},'w');assert.equal(f.ui.inspect().nodes[0].repositories[0].branch,'staging');
 f.el('add-group-node').click();await setImmediate();f.el('repository-group-select').change('g2');await setImmediate();assert.equal(f.ui.inspect().nodes.length,2);
 f.el('save-repository-canvas').click();await setImmediate();assert.equal(f.ui.isDirty(),false);assert.match(f.el('designer-message').textContent,/已保存/);
 const put=f.requests.find(r=>r.options?.method==='PUT');assert.equal(JSON.parse(put.options.body).nodes[0].repositories[0].branch,'staging');
 f.el('close-repository-editor').click();assert.equal(f.el('repository-editor').hidden,true);
});
test('designer save failures retain draft; cancellation reloads; workspace switch fences asynchronous state',async()=>{
 const f=setup();const state={workspaces:[{id:'w',group:'acme',repositories:[]}]};f.ui.render(state,'w');await setImmediate();f.elements('[data-node]')[0].click();await setImmediate();f.elements('[data-project-branch]')[0].change('staging');f.failure=true;f.el('save-repository-canvas').click();await setImmediate();assert.equal(f.ui.isDirty(),true);assert.match(f.el('designer-message').textContent,/修改已保留/);
 f.el('cancel-repository-changes').click();await setImmediate();assert.equal(f.ui.isDirty(),false);assert.equal(f.ui.inspect().nodes[0].repositories[0].branch,'main');
 f.ui.render({workspaces:[]},'');await setImmediate();assert.equal(f.ui.inspect().workspaceId,'');assert.equal(f.ui.inspect().nodes.length,0);assert.match(f.el('designer-message').textContent,/选择或新建/);
});

test('designer freezes editing until a pending save settles',async()=>{
 const f=setup();f.ui.render({workspaces:[{id:'w',group:'acme',repositories:[]}]},'w');await setImmediate();f.elements('[data-node]')[0].click();await setImmediate();
 f.elements('[data-project-branch]')[0].change('staging');f.deferSave();f.el('save-repository-canvas').click();await setImmediate();
 assert.equal(f.el('repository-group-select').disabled,true);assert.equal(f.el('remove-group-node').disabled,true);assert.equal(f.el('cancel-repository-changes').disabled,true);
 f.elements('[data-project-branch]')[0].change('main');f.el('repository-group-select').change('g2');
 assert.equal(f.ui.inspect().nodes[0].repositories[0].branch,'staging');
 f.finishSave();await setImmediate();assert.equal(f.ui.inspect().nodes[0].repositories[0].branch,'staging');assert.equal(f.el('repository-group-select').disabled,false);
});

test('designer cannot save or add nodes before configuration load succeeds, including load failures',async()=>{
 const f=setup();f.deferLoad();f.ui.render({workspaces:[{id:'w',group:'acme',repositories:[]}]},'w');
 assert.equal(f.el('save-repository-canvas').disabled,true);assert.equal(f.el('add-group-node').disabled,true);
 f.el('save-repository-canvas').click();f.el('add-group-node').click();await setImmediate();
 assert.equal(f.requests.filter(r=>r.options?.method==='PUT').length,0);assert.equal(f.ui.inspect().nodes.length,0);
 f.finishLoad();await setImmediate();assert.equal(f.ui.inspect().nodes.length,1);assert.equal(f.ui.inspect().loaded,true);
 f.loadError=true;f.el('cancel-repository-changes').click();await setImmediate();assert.equal(f.ui.inspect().loaded,false);
 f.el('add-group-node').click();f.el('save-repository-canvas').click();await setImmediate();assert.equal(f.requests.filter(r=>r.options?.method==='PUT').length,0);assert.match(f.el('designer-message').textContent,/load failed/);
});


test('Group and branch directories continue beyond page 100 without silently truncating',async()=>{
 const f=setup();f.directoryPages=101;f.ui.render({workspaces:[{id:'w',group:'acme',repositories:[]}]},'w');await setImmediate();
 f.elements('[data-node]')[0].click();await setImmediate();assert.match(f.el('repository-group-select').innerHTML,/group-101/);
 const branch=f.elements('[data-project-branch]')[0];for(const cb of branch.listeners.focus||[])cb();await setImmediate();
 assert.match(f.el('repository-projects').innerHTML,/branch-101/);
 assert.ok(f.requests.some(r=>r.url.includes('/groups?page=101')));
 assert.ok(f.requests.some(r=>r.url.includes('repository-branches?projectId=p&page=101')));
});
