"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
let modulePromise;
const reader = () => modulePromise ??= import("../scripts/ys-page.mjs");
function fixture({ value = "full-value", rows = 1, inaccessible = false } = {}) {
  const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  const box = { left: 10, top: 10, width: 30, height: 10, right: 40, bottom: 20 };
  const attrs = { type: "text", "aria-label": "Description", fieldid: "form|description" };
  const input = { tagName:"INPUT", type:"text", value, checked:false, required:false, disabled:false, readOnly:false, ownerDocument:null, labels:[], className:"", getBoundingClientRect:()=>box, getAttribute:name=>attrs[name]||null, matches:()=>false, closest:()=>null, contains:()=>false, querySelector:()=>null, querySelectorAll:()=>[] };
  const toolbar = { tagName:"BUTTON", ownerDocument:null, className:"", innerText:"Refresh", getBoundingClientRect:()=>box, getAttribute:name=>name==="fieldid"?"page|btnRefresh":null, matches:()=>false, closest:()=>null, querySelector:()=>null, querySelectorAll:()=>[] };
  const table = { className:"", matches:()=>false, querySelector:()=>null, querySelectorAll:()=>[] };
  const dataRows = Array.from({length:rows},(_,i)=>({ tagName:"TR", ownerDocument:null, className:"", innerText:"row-"+i, getBoundingClientRect:()=>box, getAttribute:()=>null, matches:()=>false, closest:selector=>selector==="table"?table:null, querySelector:()=>null, querySelectorAll:()=>[] }));
  const frame = { ownerDocument:null, getBoundingClientRect:()=>box, clientLeft:0, clientTop:0, contentDocument:null };
  const doc = { URL:"https://example.test/page", defaultView:view, title:"Reader fixture", contains:()=>false, querySelectorAll(selector) {
    if (selector==="iframe") return inaccessible?[frame]:[];
    if (selector==="input,textarea,select" || selector==="input") return [input];
    if (selector==="[fieldid],[data-fieldid]") return [toolbar];
    if (selector==='table tbody tr,.u-table-row,.wui-table-row,.lebra-table-row,[role="row"]') return dataRows;
    return [];
  }, querySelector:()=>null };
  input.ownerDocument=toolbar.ownerDocument=frame.ownerDocument=doc; for (const row of dataRows) row.ownerDocument=doc;
  return {doc,input,dataRows,view};
}
function pageFor(fx) { return { async evaluate(fn,config) { const prevDoc=globalThis.document,prevLoc=globalThis.location,prevW=globalThis.innerWidth,prevH=globalThis.innerHeight; globalThis.document=fx.doc;globalThis.location={href:fx.doc.URL,hostname:"example.test",pathname:"/page",hash:""};globalThis.innerWidth=1000;globalThis.innerHeight=800;try{return fn(config);}finally{if(prevDoc===undefined)delete globalThis.document;else globalThis.document=prevDoc;if(prevLoc===undefined)delete globalThis.location;else globalThis.location=prevLoc;if(prevW===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=prevW;if(prevH===undefined)delete globalThis.innerHeight;else globalThis.innerHeight=prevH;} } }; }
test("context reads field value and rendered three-column rows", async()=>{const {context}=await reader();const fx=fixture({value:"x".repeat(300),rows:1});const state=await context(pageFor(fx),{parts:["fields","rows"],maxValueChars:320});assert.equal(state.complete,true);assert.equal(state.fields[0].value.length,300);assert.equal(state.fields[0].valueTruncated,false);assert.equal(state.fields[0].framePath,"0");assert.equal(state.rows,1);assert.equal(state.rowsAreTotal,false);assert.equal(state.rowMeaning,"rendered-visible-rows");assert.equal(state.coverage,"same-origin-light-dom");assert.equal(state.shadowDOM,"not-traversed");});
test("fields-only context omits every unread section and its limit flags",async()=>{const {context}=await reader();const state=await context(pageFor(fixture()),{parts:["fields"]});assert.equal(state.parts.length,1);assert.equal(state.parts[0],"fields");for(const key of ["toolbar","rows","rowsAreTotal","rowMeaning","rowSampleLimit","errors","toasts","busy","busyCount","modal","modalCount"])assert.equal(Object.hasOwn(state,key),false,key+" must be omitted when not read");assert.deepEqual(Object.keys(state.limits),["fields"]);});
test("context marks clipped field values and excess rows",async()=>{const {context}=await reader();const state=await context(pageFor(fixture({value:"long-value",rows:3})),{parts:["fields","rows"],maxValueChars:4,maxRows:2});assert.equal(state.fields[0].value,"long");assert.equal(state.fields[0].valueTruncated,true);assert.equal(state.truncated,true);assert.equal(state.limits.rows,true);assert.equal(state.limits.fields,false);});
test("fingerprint changes when only a non-BMP field value changes",async()=>{const {context}=await reader();const fx=fixture({value:"🟩"});const page=pageFor(fx);const first=await context(page,{parts:["fields"]});fx.input.value="🟦";const second=await context(page,{parts:["fields"]});assert.notEqual(first.fingerprint,second.fingerprint);});
test("waitIdle checks changing content and honors the target predicate",async()=>{const {waitIdle}=await reader();let value="loading",polls=0;const fx=fixture();Object.defineProperty(fx.input,"value",{get:()=>value});const promise=waitIdle(pageFor(fx),{timeout:500,step:1,parts:["fields"],until:state=>{polls++;return state.fields[0]?.value==="ready";}});setTimeout(()=>{value="ready";},10);const result=await promise;assert.equal(result.ok,true);assert.equal(result.readiness,"predicate");assert.equal(result.businessVerified,false);assert.ok(polls>=2);});
test("context scopes away unrelated frames and scan exposes display limits",async()=>{const {context,scan}=await reader();const fx=fixture({inaccessible:true});const scoped=await context(pageFor(fx),{parts:["fields"],scope:"input"});assert.equal(scoped.complete,true);assert.deepEqual(scoped.unreadFrames,[]);assert.equal(scoped.documents[0].framePath,"0");assert.equal(scoped.scope,"input");const state=await context(pageFor(fx),{parts:["fields"]});assert.equal(state.complete,false);assert.equal(state.unreadFrames[0].reason,"inaccessible-frame");const list=await scan(pageFor(fixture()),{limit:1});assert.equal(list.elementLimit,1);assert.equal(typeof list.truncated,"boolean");assert.equal(list.displayLimit,1);});



