import {spawn} from 'node:child_process';
import {createGateway} from './gateway.mjs';
if (process.env.CLIPS_AUDIO_ROLLOUT_APPROVED!=='true') {
  console.error('audio_rollout_not_approved'); process.exit(78);
}
let server;
try { server=createGateway({token:process.env.CLIPS_SOUNDBOX_PROXY_TOKEN}); }
catch { console.error('gateway_configuration_invalid');process.exit(78); }
const env={...process.env}; delete env.CLIPS_SOUNDBOX_PROXY_TOKEN;
const child=spawn(process.execPath,['/opt/soundbox/server/dist/cli.js','--host','127.0.0.1','--port','17494'],{
  env,stdio:['ignore','ignore','ignore'],
});
let stopping=false;
function stop(code) {
  if (stopping) return; stopping=true;
  server.closeAllConnections();server.close();child.kill('SIGTERM');
  setTimeout(()=>{child.kill('SIGKILL');process.exit(code);},5000).unref();
  child.once('exit',()=>process.exit(code));
  if (child.exitCode!==null || child.signalCode!==null) process.exit(code);
}
child.on('error',()=>stop(1));child.on('exit',()=>stop(stopping ? 0 : 1));
server.on('error',()=>stop(1));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>stop(0));
server.listen(Number(process.env.PORT||8080),'::');
