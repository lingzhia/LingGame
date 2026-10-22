#!/usr/bin/env node
'use strict';
/* ============================================================
 * WordTower headless 数据模式运行器
 *
 * 用法：
 *   node headless.js                      交互模式：stdin 每行一条 JSON 命令，stdout 回 JSON
 *   node headless.js scenario.json        脚本模式：命令数组一次跑完
 *   node headless.js --replay <记录文件>   重放一局存档（records/*.jsonl）
 *
 * 命令（JSON）：
 *   {"op":"newGame","seed":123,"aiLevel":2}
 *   {"op":"snapshot"}
 *   {"op":"place","hand":0,"c":3,"r":5}        手牌第 0 格摆到 (3,5)
 *   {"op":"move","from":{"c":1,"r":2},"to":{"c":1,"r":3}}   盘上移动/合成
 *   {"op":"recycle","c":1,"r":2}               遣散守军折馒头
 *   {"op":"road","hand":2}                     手牌兵上路排队
 *   {"op":"fuse","a":0,"b":1}                  兵营里两张牌合成
 *   {"op":"enlist"}                            征兵刷新 5 格
 *   {"op":"tick","sec":10}   / {"op":"tick","to":45.5}      推进时间（0.1s 步长）
 *   {"op":"shop","buy":"liangcao"} / {"op":"shop","close":true}
 *   {"op":"useActive","slot":0}
 *   {"op":"startWave"} / {"op":"set","key":"mantou","value":99}
 *   {"op":"stop"}
 *
 * 对局存档：records/<时间>_seed<种子>.jsonl（JSON Lines）
 *   首行 {op:"newGame", seed, aiLevel} → 中间每行一条操作 → 末行 {op:"_end", result}
 *   同 seed + 同操作序列 = 同结果，重放即可复现整局。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');

const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, 'WordTower.html');
const RECORDS_DIR = path.join(ROOT, 'records');
const TICK = 0.1;

/* ---------------- 桩层：canvas / DOM / 音频 ---------------- */
function universal(){
  const fn = function(){ return p; };
  const p = new Proxy(fn, {
    get(t, k){
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'width' || k === 'length') return 0;
      return p;
    },
    set(){ return true; },
    apply(){ return p; },
  });
  return p;
}

function makeSandbox(){
  const listeners = {};
  const canvas = {
    getContext: () => universal(),
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(){},
    _fire(type, ev){ (listeners[type] || []).forEach(fn => fn(ev)); },
    style: {}, width: 0, height: 0,
    getBoundingClientRect: () => ({ left:0, top:0, width:720, height:1446 }),
  };
  const store = {};                         // localStorage 桩：录制/回放要用
  const sb = {
    console, Math, Date, JSON,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,          // 不启动渲染循环
    cancelAnimationFrame(){},
    addEventListener(){}, removeEventListener(){},   // boot() 里 window.addEventListener('resize')
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    _canvas: canvas,
    location: { search: '', href: 'http://localhost/headless' },
    devicePixelRatio: 1, innerWidth: 720, innerHeight: 1446,
    document: {
      getElementById: () => canvas,
      createElement: () => ({ style:{}, value:'', appendChild(){}, addEventListener(){},
                              setAttribute(){}, remove(){}, focus(){}, blur(){} }),
      body: { appendChild(){}, removeChild(){} },
      addEventListener(){}, removeEventListener(){},
      visibilityState: 'visible', activeElement: null,
    },
  };
  sb.window = sb;                            // 游戏代码里 window.xxx 挂在全局
  sb.globalThis = sb;
  return sb;
}

function loadGame(){
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('WordTower.html 里找不到 <script> 代码块');
  const sb = makeSandbox();
  vm.createContext(sb);
  vm.runInContext(m[1], sb, { filename: 'WordTower.js' });
  const api = sb.__api;
  if (!api) throw new Error('加载完成但 window.__api 不存在（页面初始化可能崩了）');
  return { sb, api };
}

/* ---------------- 对局记录 ---------------- */
let recFile = null;
let recEnded = true;
let REPLAYING = false;      // 重放时不写新存档

function recStart(seed, aiLevel){
  if (REPLAYING) return;
  if (!fs.existsSync(RECORDS_DIR)) fs.mkdirSync(RECORDS_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  recFile = path.join(RECORDS_DIR, `${stamp}_seed${seed}.jsonl`);
  recEnded = false;
  fs.writeFileSync(recFile, JSON.stringify({ op:'newGame', seed, aiLevel, ts:new Date().toISOString() }) + '\n');
  return recFile;
}
function recOp(name, args){
  if (!recFile || recEnded || REPLAYING) return;
  fs.appendFileSync(recFile, JSON.stringify({ t:+(api.G ? api.G.time : 0).toFixed(2), op:name, args }) + '\n');
}
function recEnd(result){
  if (!recFile || recEnded || REPLAYING) return;
  recEnded = true;
  fs.appendFileSync(recFile, JSON.stringify({ op:'_end', result, time:+api.G.time.toFixed(2) }) + '\n');
}

/* ---------------- 命令实现 ---------------- */
let api = null;

function cellIdx(c, r){ return c + r * 8; }
function resolveCell(o){
  if (o == null) return -1;
  if (typeof o === 'number') return o;
  if (typeof o.idx === 'number') return o.idx;
  return cellIdx(o.c, o.r);
}
function err(msg){ return { ok:false, error:msg }; }

const SETTABLE = ['mantou','myLife','enLife','wave','merit','time','prepT','waveT'];

function takeHand(i){
  const G = api.G;
  if (i == null || i < 0 || i >= G.hand.length || !G.hand[i]) return null;
  const t = G.hand[i];
  G.hand[i] = null;
  return t;
}

function doNewGame(a = {}){
  const seed = (a.seed === undefined || a.seed === null)
    ? ((Math.random() * 1e9) | 0) : (a.seed | 0) >>> 0;
  if (a.aiLevel !== undefined) api.setAILevel(a.aiLevel);
  api.newGame(seed);                 // 种子化：地图 + 对局随机全部可复现
  api.startBattle();                 // 进入备战（15s），tick 会自动开波
  recStart(seed, a.aiLevel);
  return { ok:true, seed, aiLevel:a.aiLevel, record:recFile, note:'phase=prep，tick 开始后自动开波' };
}

function doPlace(a){
  const G = api.G;
  const idx = resolveCell(a);
  const t = takeHand(a.hand);
  if (!t) return err(`手牌第 ${a.hand} 格是空的`);
  const src = { kind:t.kind, type:t.type, char:t.char, level:t.level };
  const res = api.dropOnCell(src, idx);
  if (res === 'fail' || res === 'shovel-no') G.hand[a.hand] = t;   // 失败放回（同 onUp 语义）
  return { ok:res !== 'fail' && res !== 'shovel-no', res };
}

function doMove(a){
  const G = api.G;
  const from = resolveCell(a.from), to = resolveCell(a.to);
  const u = G.board[from];
  if (!u) return err(`(${from}) 格上没有兵`);
  const src = { kind:u.kind, type:u.type, char:u.char, level:u.level, __fromBoard:from };
  const res = api.dropOnCell(src, to);
  return { ok:res !== 'fail' && res !== 'shovel-no', res };
}

function doTick(a){
  const G = api.G;
  let target = -1;
  if (a.to !== undefined) target = +a.to;
  else if (a.sec !== undefined) target = G.time + +a.sec;
  else return err('tick 需要 sec 或 to');
  let steps = 0;
  while (G.time < target - 1e-9 && !G.result && steps < 200000){
    api.step(TICK); steps++;
    if (G.phase === 'shop' || G.phase === 'intro') break;   // 商店冻结时间，需显式 close（与真人一致）
  }
  return { ok:true, time:+G.time.toFixed(2), phase:G.phase,
           shopOpen:G.phase === 'shop', result:G.result || undefined };
}

const HANDLERS = {
  newGame:  doNewGame,
  snapshot: () => ({ ok:true, snapshot:api.snapshotData() }),
  place:    doPlace,
  move:     doMove,
  recycle:  (a) => {
    const idx = resolveCell(a);
    const v = api.recycleCell(idx);
    return v ? { ok:true, refunded:v, mantou:api.G.mantou } : err(`(${idx}) 格上没有兵`);
  },
  road:     (a) => {
    const G = api.G;
    const t = takeHand(a.hand);
    if (!t) return err(`手牌第 ${a.hand} 格是空的`);
    const m = api.sendTileToRoad('me', t);
    if (!m){ G.hand[a.hand] = t; return err('路上没有空位可排队'); }
    return { ok:true, at:{ x:Math.round(m.x), y:Math.round(m.y) }, queued:true };
  },
  fuse:     (a) => {
    const G = api.G;
    const sa = G.hand[a.a], sbt = G.hand[a.b];
    if (!sa || !sbt) return err('兵营格为空');
    const comb = api.tryCombine(sa, sbt);
    if (!comb) return err('这两张合不到一起');
    G.hand[a.b] = comb; G.hand[a.a] = null;
    return { ok:true, got:comb };
  },
  enlist:   () => { api.enlist(); return { ok:true, hand:api.G.hand.map(t => t && (t.char || t.type || t.kind)) }; },
  tick:     doTick,
  shop:     (a) => {
    if (a.close){
      if (api.G.phase !== 'shop') return err('当前没有商店');
      api.closeShop(); return { ok:true, phase:api.G.phase };
    }
    if (a.buy){ api.buyItem(a.buy); return { ok:true }; }
    return { ok:true, stock:api.G.shopStock };
  },
  useActive:(a) => { api.useActive(a.slot | 0); return { ok:true }; },
  startWave:() => { api.startWave(); return { ok:true, wave:api.G.wave, phase:api.G.phase }; },
  set:      (a) => {
    if (SETTABLE.indexOf(a.key) < 0) return err(`set 只允许：${SETTABLE.join(',')}`);
    api.G[a.key] = a.value;
    return { ok:true, key:a.key, value:a.value };
  },
  pause:    (a) => { api.setPaused(!!a.v); return { ok:true, paused:api.G.paused }; },
  ping:     () => ({ ok:true, time:+api.G.time.toFixed(2), phase:api.G.phase, wave:api.G.wave }),
  stop:     () => ({ ok:true, bye:true }),
};

function exec(cmd){
  if (!cmd || typeof cmd.op !== 'string') return err('命令需要 op 字段');
  const h = HANDLERS[cmd.op];
  if (!h) return err(`未知命令：${cmd.op}（可用：${Object.keys(HANDLERS).join(', ')}）`);
  let out;
  try { out = h(cmd); }
  catch (e){ return err('执行异常：' + e.message); }
  if (cmd.op !== 'newGame'){
    const { op, ...args } = cmd;                 // 只存参数本身，避免嵌套
    recOp(cmd.op, args);
  }
  if (api.G && api.G.result && !recEnded) recEnd(api.G.result);
  return out;
}

/* ---------------- 三种运行方式 ---------------- */
function out(o){ process.stdout.write(JSON.stringify(o) + '\n'); }

function interactive(){
  out({ ok:true, note:'WordTower headless。每行一条 JSON 命令，如 {"op":"newGame","seed":1}' });
  const rl = readline.createInterface({ input:process.stdin, terminal:false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let cmd;
    try { cmd = JSON.parse(s); } catch { out(err('JSON 解析失败')); return; }
    const r = exec(cmd);
    out(r);
    if (cmd.op === 'stop' && r.ok){ recEnd(api.G.result); process.exit(0); }
  });
  rl.on('close', () => { recEnd(api.G && api.G.result); });
}

function runScript(file){
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.trim().split('\n').map(l => l.trim()).filter(Boolean);
  let cmds;
  try { cmds = JSON.parse(lines.length > 1 || lines[0].startsWith('{') ? '[' + lines.join(',').replace(/^,|,$/g,'') + ']' : txt); }
  catch { cmds = JSON.parse(txt); }
  if (!Array.isArray(cmds)) cmds = cmds.commands || [cmds];
  for (const c of cmds){
    const r = exec(c);
    if (c.op === 'snapshot') out(r);
    if (!r.ok) out({ op:c.op, ...r });
    if (r.bye) break;
  }
  const G = api.G;
  out({ done:true, result:G.result, time:+G.time.toFixed(2), wave:G.wave, record:recFile });
  recEnd(G.result);
}

function replay(file){
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  let expected = null;
  REPLAYING = true;
  for (const line of lines){
    const rec = JSON.parse(line);
    if (rec.op === '_end'){ expected = rec.result; continue; }
    const cmd = rec.args !== undefined ? { op:rec.op, ...rec.args } : { ...rec };
    const r = exec(cmd);
    if (!r.ok && rec.op !== 'snapshot' && rec.op !== 'ping') out({ replayWarn:rec.op, ...r });
  }
  const G = api.G;
  out({ replay:file, result:G.result, expected, match:!expected || expected === G.result,
        time:+G.time.toFixed(2), wave:G.wave,
        finalSnapshot:api.snapshotData() });
}

function main(){
  ({ api } = loadGame());
  const arg = process.argv[2];
  if (!arg) return interactive();
  if (arg === '--replay') return replay(process.argv[3]);
  return runScript(path.resolve(arg));
}

if (require.main === module){
  try { main(); }
  catch (e){ out({ ok:false, fatal:e.message, stack:e.stack }); process.exit(1); }
}

module.exports = { loadGame, exec };      // 测试脚本可以直接复用加载器
