#!/usr/bin/env node
'use strict';
/* 字池新规则验证：单一套卡 / 离开战场按份回池 / 不再重洗 */
const fs = require('fs'), path = require('path'), vm = require('vm');

function universal(){
  const fn = function(){ return p; };
  const p = new Proxy(fn, {
    get(t, k){ if (k === Symbol.toPrimitive) return () => 0; if (k === 'width' || k === 'length') return 0; return p; },
    set(){ return true; }, apply(){ return p; },
  });
  return p;
}
function makeSandbox(){
  const canvas = { getContext: () => universal(), addEventListener(){}, removeEventListener(){},
    style: {}, width: 0, height: 0, getBoundingClientRect: () => ({ left:0, top:0, width:720, height:1446 }) };
  const sb = { console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set,
    parseFloat, parseInt, isFinite, isNaN, Symbol, Promise, Error, TypeError,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0, cancelAnimationFrame(){},
    addEventListener(){}, removeEventListener(){},
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
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  };
  sb.window = sb;
  sb.globalThis = sb;
  return sb;
}

const html = fs.readFileSync(path.join(__dirname, 'WordTower.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const sb = makeSandbox();
vm.createContext(sb);
vm.runInContext(m[1], sb, { filename: 'WordTower.js' });
const api = sb.__api;
if (!api) throw new Error('no __api');

let pass = 0, fail = 0;
function ok(cond, msg){
  if (cond){ pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}
function count(v){ return api.G.charPool.filter(c => c === v).length; }

/* --- 0. 全新对局：24 字（关/张/黄 各 3 份，其余 1 份） --- */
ok(api.G.charPool.length === 24, '开局池 24 字，实际 ' + api.G.charPool.length);
ok(count('关') === 3 && count('张') === 3 && count('黄') === 3,
   '同姓字各 3 份（关/张/黄），实际 ' + count('关') + '/' + count('张') + '/' + count('黄'));

/* --- 1. 摸空即空，不再重洗 --- */
let drawn = 0;
for (let i = 0; i < 30; i++){
  const c = api.drawPoolChar(false);
  if (c == null) break;
  drawn++;
}
ok(drawn === 24, '最多摸 24 张，实际 ' + drawn);
ok(api.G.charPool.length === 0, '摸空后池为空');
let allNull = true;
for (let i = 0; i < 5; i++) if (api.drawPoolChar(false) !== null) allNull = false;
ok(allNull, '摸空后再摸返回 null（不重洗）');

/* --- 2. 回池：按份退回 --- */
api.returnTileChars({ kind:'char', char:'黄' });
ok(count('黄') === 1, '字回池（黄 x1）');
api.returnTileChars({ kind:'hero', type:'黄忠' });
ok(count('黄') === 2 && count('忠') === 1, '再回一个黄忠：黄 x2 忠 x1（同名可多份）');
api.returnTileChars({ kind:'shovel' });
ok(api.G.charPool.length === 3, '铲子不占池，实际 ' + api.G.charPool.length);

/* --- 3. 场上的字实时排除（兜底）--- */
api.G.charPool = ['黄', '忠', '关'];
api.G.board.fill(null); api.G.enBoard.fill(null);
api.G.board[10] = { kind:'char', char:'黄', hp:1, maxHp:1, level:0, cell:10, cells:[10], born:0 };
let got = new Set(), drew = 0;
for (let i = 0; i < 60; i++){ const c = api.drawPoolChar(false); if (c){ got.add(c); drew++; } }
ok(drew === 2 && got.has('忠') && got.has('关') && !got.has('黄'), '场上有黄：摸不出黄（兜底过滤生效）');
ok(api.G.charPool.length === 1 && count('黄') === 1, '场上的字不会被从池里划走');

/* --- 4. 名将阵亡 -> 两字回池（killDefender 里 returnTileChars 的等价调用） --- */
api.G.board[10] = { kind:'hero', type:'黄忠', hero:'黄忠', char:'黄', level:1,
  hp:100, maxHp:100, atk:10, rate:1, range:1, cells:[10,11], cell:10, span:2, xp:0, cd:0, born:0 };
api.G.charPool = [];                          // 极端：池空
api.returnTileChars(api.G.board[10]);
ok(count('黄') === 1 && count('忠') === 1, '池空时名将阵亡：黄/忠 各回 1 份');

/* --- 5. takePoolChar 指定摸字：场上有同名将时摸不到 --- */
api.G.board.fill(null);
api.G.charPool = ['黄'];
api.takePoolChar('黄') === true ? pass++ : (fail++, console.log('  FAIL 场上没黄忠时应能摸到黄'));
ok(api.G.charPool.length === 0, '指定摸字会从池里划走');
api.returnTileChars({ kind:'hero', type:'黄忠' });
api.G.board[10] = { kind:'hero', type:'黄忠', hero:'黄忠', char:'黄', level:1,
  hp:100, maxHp:100, atk:10, rate:1, range:1, cells:[10,11], cell:10, span:2, xp:0, cd:0, born:0 };
const blocked = !api.takePoolChar('黄');      // board[10] 已重新摆上黄忠
ok(blocked, '场上有黄忠：指定摸黄被拦');
api.G.board.fill(null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
