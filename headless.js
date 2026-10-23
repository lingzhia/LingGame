#!/usr/bin/env node
'use strict';
/* ============================================================
 * WordTower headless 数据模式运行器
 *
 * 用法：
 *   node headless.js                      交互模式：stdin 每行一条 JSON 命令，stdout 回 JSON
 *   node headless.js scenario.json        脚本模式：命令数组一次跑完
 *   node headless.js --replay <记录文件>   重放一局存档（records/*.jsonl）
 *   node headless.js --selfplay 5 [aiLevel] [seed] [--lives=15]
 *                                          两边都交给 bot 自对弈，报胜负/波次/异常
 *                                          --lives 只用于测试：把双方主公命数调高，让对局长到中后期
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
 *   {"op":"autopilot","v":true}                挂机：电脑接管我方（两边都是 bot 即自对弈）
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
let NO_REC = false;         // 批量自对弈：不写存档文件

function recStart(seed, aiLevel){
  if (REPLAYING || NO_REC) return;
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
  autopilot:(a) => { const v = api.setAutopilot(a.v === undefined ? true : !!a.v);
                     return { ok:true, autopilot:v }; },
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

/* 重放浏览器存的录像（records/web/*.json，格式 {seed, aiLevel, events:[[步,x0,y0,x1,y1]]}）：
   和游戏里的「回放本局」走同一条路径 —— startReplay + 逐帧推进，所以状态完全一致。 */
function replayWeb(file){
  REPLAYING = true;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : [raw];
  const results = list.map((rec) => {
    api.startReplay(rec, 'over');
    if (!api.REPLAY.on) return { ok:false, error:'回放无法启动', seed:rec.seed };
    let guard = 0;
    while (api.REPLAY.on && guard++ < 60 * 60 * 20){ api.draw(); api.simAdvance(1 / 30); }
    const G = api.G;
    return { seed:rec.seed, expected:rec.result, result:G.result, match:!rec.result || rec.result === G.result,
             time:+G.time.toFixed(2), wave:G.wave, actions:(rec.events || []).length,
             finalSnapshot:api.snapshotData() };
  });
  out({ replay:file, count:results.length, results });
}


/* ---------------- 自对弈：两边都交给 bot，批量跑局找 bug ----------------
   用法：node headless.js --selfplay 10 [aiLevel]
   输出：每局一行摘要 + 汇总（胜负分布、平均波次、异常清单）。
   检查的是「规则不变量」，不是胜负 —— 胜负只是参考，异常才是要修的东西。 */
function checkGame(G){
  const bad = [];
  const who = (v) => v ? 'ai' : 'me';
  const boards = [['我方', G.board, true], ['敌方', G.enBoard, false]];
  for (const [tag, board, mine] of boards){
    for (let i = 0; i < board.length; i++){
      const u = board[i];
      if (!u) continue;
      const at = tag + '第' + i + '格';
      if (u.hp !== undefined && !(u.hp > 0)) bad.push(at + ' 血量为 ' + u.hp + ' 还留在盘上');
      if (u.atk !== undefined && !isFinite(u.atk)) bad.push(at + ' 攻击力非数字');
      // 名将横占两格：非锚点格里放的是同一个对象，属于正常，只查「这格不在它的占格里」
      if (u.cells && u.cells.length && u.cells.indexOf(i) < 0) bad.push(at + ' 不在该单位的占格列表里');
      if (api.isPathCell(i, mine)) bad.push(at + ' 兵压在路格上');
      if (api.isAduCell(i, mine)) bad.push(at + ' 兵压在主公格上');
      if (u.kind === 'unit' && !u.type) bad.push(at + ' 兵种为空');
      if (u.kind === 'hero'){
        const cs = u.cells || [];
        if (cs.length !== 2) bad.push(at + ' 名将占格数 = ' + cs.length);
        else if (Math.abs(cs[0] - cs[1]) !== 1) bad.push(at + ' 名将两格不相邻');
      }
    }
  }
  for (const m of G.marchers){
    if (!isFinite(m.x) || !isFinite(m.y)) bad.push('行军兵坐标非数字');
    if (!(m.hp > 0)) bad.push('行军兵血量 = ' + m.hp + ' 还在场上');
    if (!m.route || !m.route.length) bad.push('行军兵没有路线');
  }
  if (G.marchers.length > 220) bad.push('场上行军兵过多：' + G.marchers.length);
  if (G.myLife < 0 || G.enLife < 0) bad.push('主公命数变负');
  if (G.myLife > G.myMax || G.enLife > G.enMax) bad.push('主公命数超过上限');
  if (G.mantou < -1e-9 || G.ai.mantou < -1e-9) bad.push('馒头变负');
  if (G.hand.length !== 0 && G.hand.length !== 5) bad.push('我方手牌格数 = ' + G.hand.length);
  if (G.ai.hand.length !== 0 && G.ai.hand.length !== 5) bad.push('敌方手牌格数 = ' + G.ai.hand.length);
  if (G.wave > 200) bad.push('波次失控：' + G.wave);
  return bad;
}

function selfplay(count, aiLevel, firstSeed, lives){
  NO_REC = true;
  const games = [];
  const issues = [];
  let wins = 0, loses = 0, stuck = 0;
  for (let i = 0; i < count; i++){
    const seed = (firstSeed + i * 7919) >>> 0;
    api.setAILevel(aiLevel);
    api.newGame(seed);
    if (lives > 0){ api.G.myLife = api.G.myMax = lives; api.G.enLife = api.G.enMax = lives; }
    api.setAutopilot(true);
    api.startBattle();
    let steps = 0, sawShop = 0;
    const LIMIT = 30000;                       // 3000 秒（游戏内时间）还没打完 = 卡死
    while (!api.G.result && steps < LIMIT){
      api.step(0.1); steps++;
      if (api.G.phase === 'shop') sawShop++;
    }
    const G = api.G;
    const bad = checkGame(G);
    if (!G.result){ stuck++; bad.push('跑满 ' + (LIMIT/10) + ' 秒仍未分胜负（停在 phase=' + G.phase + '）'); }
    if (G.result === 'win') wins++; else if (G.result === 'lose') loses++;
    if (bad.length) issues.push({ seed, issues: bad });
    games.push({ seed, result:G.result || 'none', wave:G.wave, time:+G.time.toFixed(0),
                 myLife:G.myLife, enLife:G.enLife, shopFreezes:sawShop,
                 meGuards:api.guardCount ? api.guardCount(G.board) : G.board.filter(Boolean).length,
                 aiGuards:G.enBoard.filter(Boolean).length,
                 meDug:Object.keys(G.unlocked).length - 7, aiDug:Object.keys(G.aiUnlocked).length });
  }
  const avg = k => +(games.reduce((a, g) => a + g[k], 0) / games.length).toFixed(1);
  return { ok: issues.length === 0, count, aiLevel, wins, loses, stuck,
           avgWave:avg('wave'), avgTime:avg('time'), avgMyDug:avg('meDug'), avgAiDug:avg('aiDug'),
           avgMyGuards:avg('meGuards'), avgAiGuards:avg('aiGuards'),
           games, issues };
}

function main(){
  ({ api } = loadGame());
  const arg = process.argv[2];
  if (!arg) return interactive();
  if (arg === '--replay') return replay(process.argv[3]);
  if (arg === '--selfplay'){
    const rest = process.argv.slice(3);
    const livesArg = rest.find(a => a.startsWith('--lives='));
    const lives = livesArg ? Number(livesArg.split('=')[1]) : 0;
    const nums = rest.filter(a => !a.startsWith('--'));
    const n = Math.max(1, Number(nums[0] || 5));
    const lv = Number(nums[1] !== undefined ? nums[1] : 1);
    const seed = Number(nums[2] || 1001);
    return out(selfplay(n, lv, seed, lives));
  }
  if (arg === '--replay-web') return replayWeb(process.argv[3]);
  return runScript(path.resolve(arg));
}

if (require.main === module){
  try { main(); }
  catch (e){ out({ ok:false, fatal:e.message, stack:e.stack }); process.exit(1); }
}

module.exports = { loadGame, exec };      // 测试脚本可以直接复用加载器
