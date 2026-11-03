// Logical operations copied from the owning HTML BRIDGE-CONTRACT f7a9ab5d...632b.
// These are not network URLs; the Velo backend receives no arbitrary proxy target.
const id='([A-Za-z0-9_-]{1,80})';
export const OPERATIONS=Object.freeze([
 ['session.get','GET',/^\/api\/beta\/session$/],['session.select','POST',/^\/api\/beta\/session$/],
 ['records.directory','POST',/^\/api\/beta\/record-directory$/],
 ['records.read','GET',new RegExp('^/api/beta/records/'+id+'$')],['records.write','POST',new RegExp('^/api/beta/records/'+id+'$')],
 ['records.deliver','POST',new RegExp('^/api/beta/records/'+id+'/drive-delivery$')],
 ['originals.put','PUT',new RegExp('^/api/beta/originals/'+id+'$')],['originals.get','GET',new RegExp('^/api/beta/originals/'+id+'$')],['auth.logout','POST',/^\/auth\/logout$/],
 ['model.contextOpen','POST',/^\/api\/beta\/model-context\/open$/],['model.contextClose','POST',/^\/api\/beta\/model-context\/close$/],
 ['model.jobSubmit','POST',/^\/api\/beta\/jobs$/],['model.jobPoll','POST',/^\/api\/beta\/jobs\/poll$/],['model.jobCancel','POST',/^\/api\/beta\/jobs\/cancel$/]
].map(([op,method,path])=>Object.freeze({op,method,path})));
export const REQUEST_HEADERS=Object.freeze(['content-type','x-rasp-csrf','x-rasp-actor','x-rasp-project','x-rasp-site','x-rasp-context','x-content-sha256']);
const need=(c,code)=>{if(!c)throw Error(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const b64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');};
export const decode64=s=>{need(typeof s==='string'&&/^[A-Za-z0-9_-]*$/.test(s),'BRIDGE_ENCODING');return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));};
export function operationFor(path,method){need(typeof path==='string'&&path.startsWith('/')&&!/[?#%\\]/.test(path),'BRIDGE_PATH_DENIED');const row=OPERATIONS.find(r=>r.method===method&&r.path.test(path));need(row,'BRIDGE_OPERATION_DENIED');return row.op;}
export function validateRequest(value){
 need(exact(value,['op','method','path','headers','body']),'BRIDGE_REQUEST_SHAPE');
 need(operationFor(value.path,value.method)===value.op,'BRIDGE_OPERATION_DENIED');
 need(Array.isArray(value.headers)&&value.headers.every(h=>Array.isArray(h)&&h.length===2&&REQUEST_HEADERS.includes(h[0])&&typeof h[1]==='string'&&!/[\r\n]/.test(h[1])),'BRIDGE_HEADERS_DENIED');
 need(new Set(value.headers.map(h=>h[0])).size===value.headers.length,'BRIDGE_HEADERS_DENIED');
 need(exact(value.body,['encoding','data'])&&['empty','utf8','base64url'].includes(value.body.encoding)&&typeof value.body.data==='string','BRIDGE_BODY_SHAPE');
 need(value.body.encoding!=='empty'||value.body.data==='','BRIDGE_BODY_SHAPE');
 need(value.method!=='GET'||value.body.encoding==='empty','BRIDGE_BODY_SHAPE');
 if(value.body.encoding==='base64url')decode64(value.body.data);
 return value;
}
export async function encodeRequest(path,init={}){
 const method=(init.method??'GET').toUpperCase(),op=operationFor(path,method),headers=[...new Headers(init.headers??{}).entries()];
 let body={encoding:'empty',data:''};
 if(init.body!=null){
  if(typeof init.body==='string')body={encoding:'utf8',data:init.body};
  else if(init.body instanceof Blob)body={encoding:'base64url',data:b64(new Uint8Array(await init.body.arrayBuffer()))};
  else if(init.body instanceof ArrayBuffer||ArrayBuffer.isView(init.body))body={encoding:'base64url',data:b64(init.body instanceof ArrayBuffer?new Uint8Array(init.body):new Uint8Array(init.body.buffer,init.body.byteOffset,init.body.byteLength))};
  else throw Error('BRIDGE_BODY_UNSUPPORTED');
 }
 return validateRequest({op,method,path,headers,body});
}
export function decodeResponse(reply){
 need(exact(reply,['status','body'])&&Number.isInteger(reply.status)&&reply.status>=100&&reply.status<=599,'BRIDGE_REPLY_INVALID');
 return Object.freeze({ok:reply.status>=200&&reply.status<300,status:reply.status,json:async()=>structuredClone(reply.body)});
}
