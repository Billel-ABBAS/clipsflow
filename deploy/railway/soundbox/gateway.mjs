/** Private, bearer-authenticated facade. Raw Soundbox must bind to loopback. */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const JOB = new RegExp(`^/api/jobs/${UUID}$`, 'i');
const FILE = new RegExp(`^/files/${UUID}\\.wav\\?format=mp3$`, 'i');
const MAX_BODY = 16 * 1024;
const digest = value => createHash('sha256').update(value).digest();
function reply(res, status, code) {
  res.writeHead(status, {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify({error:code}));
}
function generation(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const keys = ['model','prompt','duration_s','variations','lyrics'];
  if (Object.keys(value).some(k=>!keys.includes(k)) || value.variations !== 1 ||
      typeof value.prompt !== 'string' || value.prompt.trim().length < 2 || value.prompt.length > 600 ||
      /[\u0000-\u001f\u007f]/u.test(value.prompt) || !Number.isFinite(value.duration_s)) return false;
  if (value.model === 'audiocpp-ace-step') return value.duration_s >= 10 && value.duration_s <= 60 && value.lyrics === '';
  return value.model === 'audiocpp-midashenglm-gen' && value.duration_s >= 0.5 && value.duration_s <= 3 && !Object.hasOwn(value,'lyrics');
}
async function bounded(stream, limit) {
  const parts = []; let length = 0;
  for await (const part of stream) {
    length += part.length;
    if (length > limit) throw new Error('size_limit');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, length);
}
export function createGateway({token, upstreamPort=17494, timeoutMs=45_000, maxResponseBytes=32*1024*1024, maxConcurrent=8}={}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(token)) throw new Error('gateway_key_required');
  if (!Number.isInteger(upstreamPort) || upstreamPort<1 || upstreamPort>65535 ||
      !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120_000 ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes<1 || maxResponseBytes>32*1024*1024 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent<1 || maxConcurrent>8) throw new Error('gateway_config_invalid');
  const expected = digest(`Bearer ${token}`); let active=0;
  const server = createServer(async (req,res)=>{
    const health = req.method==='GET' && req.url==='/healthz';
    if (!health && (typeof req.headers.authorization !== 'string' ||
        !timingSafeEqual(digest(req.headers.authorization),expected))) return reply(res,401,'unauthorized');
    if (req.headers.origin) return reply(res,403,'browser_access_denied');
    const post=req.method==='POST' && req.url==='/api/generate';
    const file=req.method==='GET' && FILE.test(req.url ?? '');
    if (!health && !post && !file && !(req.method==='GET' && (req.url==='/api/health' || JOB.test(req.url ?? '')))) return reply(res,404,'not_found');
    if (active>=maxConcurrent) return reply(res,429,'capacity_exceeded');
    active++;
    const abort = new AbortController();
    const timer = setTimeout(()=>abort.abort(),timeoutMs); timer.unref();
    const disconnected=()=>{if (!res.writableEnded) abort.abort();};
    res.on('close',disconnected);
    try {
      let body;
      if (post) {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(res,415,'json_required');
        if (Number(req.headers['content-length']) > MAX_BODY) return reply(res,413,'body_too_large');
        let input;
        try { input=await bounded(req,MAX_BODY); } catch { return reply(res,413,'body_too_large'); }
        let value;
        try {value=JSON.parse(input.toString('utf8'));} catch {return reply(res,400,'invalid_request');}
        if (!generation(value)) return reply(res,400,'invalid_request');
        body=JSON.stringify(value);
      }
      const upstream=await fetch(`http://127.0.0.1:${upstreamPort}${health ? '/api/health' : req.url}`,{
        method: post ? 'POST' : 'GET', body,
        headers:{'content-type':'application/json','X-Soundbox':'1'},
        redirect:'error', signal:abort.signal,
      });
      if (!upstream.ok || !upstream.body) {await upstream.body?.cancel();return reply(res,health ? 503 : 502,'upstream_unavailable');}
      const mime=upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (file ? !['audio/mpeg','audio/mp3'].includes(mime) : mime!=='application/json') {
        await upstream.body.cancel();return reply(res,502,'upstream_format_invalid');
      }
      const bytes=await bounded(upstream.body,file ? maxResponseBytes : Math.min(maxResponseBytes,1024*1024));
      if (!file) JSON.parse(bytes.toString('utf8'));
      res.writeHead(200,{'content-type':file ? 'audio/mpeg' : 'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
      res.end(health ? JSON.stringify({ok:true,inference_verified:false}) : bytes);
    } catch {
      if (!res.destroyed && !res.headersSent) reply(res,health ? 503 : 502,'upstream_unavailable');
      else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);res.off('close',disconnected);active--;
    }
  });
  server.requestTimeout=10_000; server.headersTimeout=10_000; server.maxHeadersCount=32;
  return server;
}
