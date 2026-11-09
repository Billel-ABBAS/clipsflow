import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
let createGateway;
try { ({ createGateway } = await import('./gateway.mjs')); } catch { /* TDD: absent implementation. */ }
const token = 'test_only_' + 'a'.repeat(40);
const id = '11111111-2222-4333-8444-555555555555';
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function rig(t, options = {}, handler = (_req, res) => {
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ job_id: id }));
}) {
  assert.equal(typeof createGateway, 'function', 'gateway implementation required');
  const seen = [];
  const upstream = createServer((req, res) => { seen.push({url: req.url, headers: req.headers}); handler(req, res); });
  const port = await listen(upstream);
  const gateway = createGateway({ token, upstreamPort: port, ...options });
  const endpoint = `http://127.0.0.1:${await listen(gateway)}`;
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const request = (path, init = {}) => fetch(endpoint + path, {
    ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return {seen, request, endpoint};
}
test('fails closed with missing or weak keys', () => {
  assert.equal(typeof createGateway, 'function');
  for (const invalid of [undefined, '', 'short', 'x'.repeat(200)]) assert.throws(() => createGateway({token: invalid}));
});
test('rejects unauthenticated requests without contacting upstream', async t => {
  const { endpoint, seen } = await rig(t);
  for (const auth of ['', 'Bearer wrong', `Bearer ${token}extra`]) {
    const r = await fetch(endpoint + '/api/generate', {method: 'POST', headers: {authorization: auth}});
    assert.equal(r.status, 401); assert.ok(!(await r.text()).includes(token));
  }
  assert.equal(seen.length, 0);
});
test('denies admin, traversal, query injection and browser origins', async t => {
  const {request, seen} = await rig(t);
  for (const path of ['/api/settings', '/mcp', '/api/models', '/files/../../etc/passwd',
    '/api/health?key=secret', '/api/jobs/not-a-uuid', `/files/${id}.wav?format=mp3&path=/etc/passwd`]) {
    assert.equal((await request(path)).status, 404);
  }
  assert.equal((await request('/api/health', {headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal(seen.length, 0);
});
test('forwards bounded generation without forwarding authentication or cookies', async t => {
  const {request, seen} = await rig(t);
  const r = await request('/api/generate', {method:'POST', headers:{'content-type':'application/json',cookie:'secret-cookie'},
    body:JSON.stringify({model:'audiocpp-ace-step',prompt:'Piano instrumental',duration_s:10,variations:1,lyrics:''})});
  assert.equal(r.status, 200); assert.equal((await r.json()).job_id,id);
  assert.equal(seen[0].headers.authorization, undefined); assert.equal(seen[0].headers.cookie,undefined);
  assert.equal(seen[0].headers['x-soundbox'],'1');
});
test('rejects invalid models, batch sizes, long prompts, and overlong effects', async t => {
  const {request, seen} = await rig(t);
  const base = {model:'audiocpp-midashenglm-gen',prompt:'A soft pop',duration_s:2,variations:1};
  for (const extra of [{model:'unapproved'}, {variations:5}, {duration_s:30}, {duration_s:-1}, {prompt:'x'.repeat(601)}, {output_path:'/tmp/x'}]) {
    const r=await request('/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...base,...extra})});
    assert.equal(r.status,400);
  }
  assert.equal(seen.length,0);
});
test('blocks oversized request bodies', async t => {
  const {request,seen}=await rig(t);
  const r=await request('/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(17000)});
  assert.equal(r.status,413); assert.equal(seen.length,0);
});
test('does not follow redirects or relay provider error details', async t => {
  const {request,seen}=await rig(t,{},(_req,res)=> {res.writeHead(302,{location:'http://example.com/private'});res.end(token);});
  const r=await request(`/api/jobs/${id}`); assert.equal(r.status,502);
  assert.ok(!(await r.text()).includes(token)); assert.equal(seen.length,1);
});
test('downloads MP3 bytes but strips unsafe response headers', async t => {
  const {request}=await rig(t,{},(_req,res)=>{res.writeHead(200,{'content-type':'audio/mpeg','set-cookie':'secret=1'});res.end('ID3-test');});
  const r=await request(`/files/${id}.wav?format=mp3`);
  assert.equal(r.status,200); assert.equal(await r.text(),'ID3-test'); assert.equal(r.headers.get('set-cookie'),null);
});
test('bounds response size and rejects HTML masquerading as a successful API reply', async t => {
  const {request}=await rig(t,{maxResponseBytes:4},(_req,res)=>{res.setHeader('content-type','application/json');res.end('123456');});
  assert.equal((await request(`/api/jobs/${id}`)).status,502);
});
test('enforces a response deadline', async t => {
  const {request}=await rig(t,{timeoutMs:30},()=>{});
  assert.equal((await request('/api/health')).status,502);
});
test('rejects simultaneous requests above the configured bound', async t => {
  let release;
  const {request}=await rig(t,{maxConcurrent:1},(_req,res)=>{release=()=>{res.setHeader('content-type','application/json');res.end('{}');};});
  const first=request('/api/health');
  while (!release) await new Promise(r=>setTimeout(r,1));
  assert.equal((await request('/api/health')).status,429); release(); assert.equal((await first).status,200);
});
test('rejects an HTML success body',async t=>{
  const {request}=await rig(t,{},(_req,res)=>{res.setHeader('content-type','text/html');res.end('<html>error</html>');});
  assert.equal((await request('/api/health')).status,502);
});
test('healthcheck verifies upstream but never claims verified model inference',async t=>{
  const {endpoint}=await rig(t);
  const r=await fetch(endpoint+'/healthz');assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{ok:true,inference_verified:false});
});
