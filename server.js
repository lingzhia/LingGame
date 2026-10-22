#!/usr/bin/env node
/* WordTower 联机转发服务器（零依赖）
 *
 * 职责：
 *   1) 顺手把 WordTower.html 托管出来（手机/另一台电脑直接打开就能玩）
 *   2) 维护房间表：建房 / 大厅列表 / 密码校验 / 隐私房过滤 / 解散
 *   3) 之后只做「转发」：谁发什么就原样丢给同房间的另一人，服务器不碰游戏逻辑
 *
 * 启动：
 *   node server.js              # 默认 8787
 *   PORT=9000 node server.js
 *   node server.js --port 9000
 *
 * 客户端填的地址就是 ws://<这台机器的IP或域名>:8787
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let PORT = Number(process.env.PORT || 8787);
const pi = args.indexOf('--port');
if (pi >= 0 && args[pi + 1]) PORT = Number(args[pi + 1]);

const WEB_ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

/* ---------------- 静态托管 ---------------- */
const httpServer = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/WordTower.html';
  const file = path.join(WEB_ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 · 只有本目录下的文件可访问');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ---------------- 最小 WebSocket（RFC 6455，够用就行） ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key){
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function encodeFrame(str, opcode = 1){
  const payload = Buffer.from(str, 'utf8');
  const n = payload.length;
  let head;
  if (n < 126){
    head = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65536){
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127;
    head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6);
  }
  return Buffer.concat([head, payload]);
}

httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const client = { socket, room:'', alive:true };

  const send = (obj) => {
    if (!client.alive) return;
    try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (e){ /* 对端已断 */ }
  };
  const close = () => {
    if (!client.alive) return;
    client.alive = false;
    try { socket.destroy(); } catch (e){}
    leaveRoom(client, 'peerleft');
  };

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    // 一帧可能被拆包/粘包：循环把所有完整的帧取出来
    for (;;){
      if (buf.length < 2) break;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126){ if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) break;
      const mask = masked ? buf.slice(off, off + 4) : null;
      const data = buf.slice(off + maskLen, off + maskLen + len);
      buf = buf.slice(off + maskLen + len);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

      if (opcode === 8){ close(); return; }             // close
      if (opcode === 9){ try { socket.write(encodeFrame('', 10)); } catch (e){} continue; }  // ping
      if (opcode === 1 && fin) onMessage(client, data.toString('utf8'), send, close);
    }
  });
  socket.on('error', close);
  socket.on('close', close);
});

/* ---------------- 房间表 ---------------- */
/* room -> { name, pwd, priv, started, clients:[client...] }，clients[0] 是房主 */
const rooms = new Map();

function sendTo(client, obj){
  if (!client.alive) return;
  try { client.socket.write(encodeFrame(JSON.stringify(obj))); } catch (e){}
}
function roomBrief(r){
  return { name:r.name, locked:!!r.pwd, priv:r.priv, players:r.clients.length };
}
function listRooms(){
  const list = [];
  for (const r of rooms.values()){
    if (r.priv) continue;              // 隐私房不进大厅
    if (r.started) continue;           // 已开打的不给别人进
    list.push(roomBrief(r));
  }
  return list;
}
function broadcastList(){
  const list = listRooms();
  for (const r of rooms.values()) for (const c of r.clients) sendTo(c, { t:'rooms', list });
}
/* 有人离开时通知同房间的其他人；房主离开则整间房解散 */
function leaveRoom(client, reason){
  const r = rooms.get(client.room);
  if (!r){ client.room = ''; return; }
  const isHost = r.clients[0] === client;
  r.clients = r.clients.filter(c => c !== client);
  client.room = '';
  if (!r.clients.length){
    rooms.delete(r.name);
    console.log(`[close] ${r.name} 空房回收`);
  } else if (isHost){
    for (const c of r.clients){ sendTo(c, { t:'dissolved', msg:'房主已解散房间' }); c.room = ''; }
    rooms.delete(r.name);
    console.log(`[dissolve] ${r.name} 房主离开，房间解散`);
  } else {
    for (const c of r.clients) sendTo(c, { t:reason || 'peerleft' });
    console.log(`[leave] ${r.name} 剩 ${r.clients.length} 人`);
  }
  broadcastList();
}

function onMessage(client, text, send, close){
  let m; try { m = JSON.parse(text); } catch (e){ return; }

  if (m.t === 'list'){
    send({ t:'rooms', list:listRooms() });
    return;
  }

  if (m.t === 'create'){
    const name = String(m.room || '').trim().slice(0, 24);
    if (!name){ send({ t:'err', msg:'房间号不能为空' }); return; }
    if (rooms.has(name)){ send({ t:'err', msg:'这个房间号已经有人用了' }); return; }
    if (client.room) leaveRoom(client, 'peerleft');
    const r = { name, pwd:String(m.pwd || '').slice(0, 24), priv:!!m.priv, started:false, clients:[client] };
    rooms.set(name, r);
    client.room = name;
    send({ t:'created', room:name, priv:r.priv, locked:!!r.pwd });
    console.log(`[create] ${name}${r.pwd ? ' · 有密码' : ''}${r.priv ? ' · 隐私房' : ''}`);
    broadcastList();
    return;
  }

  if (m.t === 'join'){
    const name = String(m.room || '').trim().slice(0, 24);
    const r = rooms.get(name);
    if (!r){ send({ t:'err', msg:'房间不存在或已解散' }); return; }
    if (r.started){ send({ t:'err', msg:'这局已经开始了' }); return; }
    if (r.clients.length >= 2){ send({ t:'err', msg:'房间已满（一间房只能两人）' }); return; }
    if (r.pwd && String(m.pwd || '') !== r.pwd){ send({ t:'err', msg:'密码不对' }); return; }
    if (client.room) leaveRoom(client, 'peerleft');
    client.room = name;
    r.clients.push(client);
    send({ t:'joined', room:name, host:false, peer:r.clients.length === 2 });
    for (const c of r.clients) if (c !== client) sendTo(c, { t:'peer', room:name });
    console.log(`[join] ${name} 房内 ${r.clients.length}/2`);
    broadcastList();
    return;
  }

  if (m.t === 'dissolve'){
    const r = rooms.get(client.room);
    if (!r) return;
    if (r.clients[0] !== client){ send({ t:'err', msg:'只有房主能解散' }); return; }
    for (const c of r.clients) if (c !== client){ sendTo(c, { t:'dissolved', msg:'房主已解散房间' }); c.room = ''; }
    client.room = '';
    rooms.delete(r.name);
    send({ t:'dissolved', msg:'房间已解散' });
    console.log(`[dissolve] ${r.name} 房主主动解散`);
    broadcastList();
    return;
  }

  if (m.t === 'leave'){
    leaveRoom(client, 'peerleft');
    return;
  }

  if (m.t === 'started'){
    const r = rooms.get(client.room);
    if (r && r.clients[0] === client){
      r.started = true;
      broadcastList();
    }
    return;
  }

  if (m.t === 'relay'){
    const r = rooms.get(client.room);
    if (!r) return;
    for (const c of r.clients) if (c !== client) sendTo(c, { t:'relay', data:m.data });
    return;
  }
}

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  WordTower 联机服务器已启动');
  console.log('  游戏页面： http://localhost:' + PORT + '/');
  console.log('  联机地址： ws://localhost:' + PORT + '   （同一局域网的手机/电脑把 localhost 换成这台机器的 IP）');
  console.log('');
  console.log('  Ctrl+C 结束');
});
