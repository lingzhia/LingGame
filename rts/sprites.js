/* =========================================================================
   ART · 程序化占位美术
   -------------------------------------------------------------------------
   为什么用代码画而不是先生成图片：
     1) 等距素材必须严格贴 2:1 菱形格，AI 生图很难保证角度和锚点一致
     2) 同一套光照/配色，风格统一，不会东一块西一块
     3) 全部在启动时烘焙进离屏 canvas，渲染只做 drawImage，不掉帧
     4) 将来换真图：把 unit()/bld() 返回的 img 换成 <img> 即可，其它代码不动

   烘焙结果统一是 { img, ax, ay, w, h }：
     绘制时 drawImage(img, sx-ax*z, sy-ay*z, w*z, h*z)
     (ax, ay) 是"脚底锚点"在图内的位置
   ========================================================================= */
window.ART = (function(){
'use strict';

const HW = 32, HH = 16;       // 一格 = 64×32 的菱形
const SS = 2;                 // 超采样倍数，放大时不糊
const DIRS = 16;

const BLD = {
  yard:     {w:4, h:4, H:46, wall:'#46586a', roof:'#7b8d9c', dark:'#2c3a46', name:'建造厂'},
  barracks: {w:3, h:3, H:30, wall:'#585040', roof:'#8b7f66', dark:'#383226', name:'兵营'},
  refinery: {w:4, h:3, H:34, wall:'#41545a', roof:'#79928f', dark:'#28383c', name:'精炼厂'},
  power:    {w:3, h:3, H:32, wall:'#4c525c', roof:'#838b96', dark:'#31363d', name:'发电厂'},
};

const UNIT = {
  inf:  {name:'步兵'},
  tank: {len:56, wid:34, name:'坦克'},
  harv: {len:48, wid:30, name:'采矿车'},
};

const TEAM = [
  {accent:'#5f9fe0', glow:'#b6d9ff', emblem:'#a9d3ff', body:'#4a7bb0'},
  {accent:'#e0644f', glow:'#ffb3a3', emblem:'#ffc0b0', body:'#a8544a'},
];

/* ---------------- 小工具 ---------------- */
function mk(w,h){
  const c = document.createElement('canvas');
  c.width = Math.ceil(w*SS); c.height = Math.ceil(h*SS);
  const x = c.getContext('2d');
  x.scale(SS,SS);
  return {cv:c, c:x, w, h};
}
function poly(c, pts, fill){
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for(let i=1;i<pts.length;i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  if(fill){ c.fillStyle = fill; c.fill(); }
}
const lerpP = (a,b,t)=> [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
const midP  = (a,b)=> [(a[0]+b[0])/2, (a[1]+b[1])/2];
function rr(c, x, y, w, h, r){
  c.beginPath();
  c.moveTo(x+r,y);
  c.arcTo(x+w,y,x+w,y+h,r);
  c.arcTo(x+w,y+h,x,y+h,r);
  c.arcTo(x,y+h,x,y,r);
  c.arcTo(x,y,x+w,y,r);
  c.closePath();
}
function grain(o, amp){
  const {c, w, h} = o;
  const img = c.getImageData(0,0,w*SS,h*SS);
  const d = img.data;
  for(let i=0;i<d.length;i+=4){
    const n = (Math.random()-.5)*amp;
    d[i]   = Math.max(0,Math.min(255,d[i]+n));
    d[i+1] = Math.max(0,Math.min(255,d[i+1]+n));
    d[i+2] = Math.max(0,Math.min(255,d[i+2]+n));
  }
  c.putImageData(img,0,0);
}
function lighten(hex, k){
  const n = parseInt(hex.slice(1),16);
  let r = (n>>16)&255, g = (n>>8)&255, b = n&255;
  const f = k<0 ? 0 : 255;
  r = Math.round(r + (f-r)*k); g = Math.round(g + (f-g)*k); b = Math.round(b + (f-b)*k);
  return `rgb(${r},${g},${b})`;
}

/* =========================================================================
   建筑
   ========================================================================= */
function softShadow(c, pts){
  for(let i=3;i>=1;i--){
    const o = i*2;
    poly(c, pts.map(p=>[p[0]+o, p[1]+o*1.3]), `rgba(0,0,0,${.055})`);
  }
}

function bakeBuilding(type, owner){
  const d = BLD[type];
  const W = (d.w+d.h)*HW + 64;
  const H = (d.w+d.h)*HH + d.H + 56;
  const o = mk(W,H);
  const c = o.c;
  // 让 (0,0) 格点落在 oy 上，footprint 向下展开，屋顶向上留 H
  const ox = d.h*HW + 30, oy = d.H + 30;
  const X = (gx,gy)=> ox + (gx-gy)*HW;
  const Y = (gx,gy)=> oy + (gx+gy)*HH;
  const up = (p,z)=> [p[0], p[1]-z];

  const A = [X(0,0),    Y(0,0)];
  const B = [X(d.w,0),  Y(d.w,0)];
  const C = [X(d.w,d.h),Y(d.w,d.h)];
  const D = [X(0,d.h),  Y(0,d.h)];

  softShadow(c, [A,B,C,D]);

  /* ---- 墙体：左墙受光，右墙背光 ---- */
  const gLeft = c.createLinearGradient(0, C[1]-d.H, 0, C[1]);
  gLeft.addColorStop(0, lighten(d.wall, .22));
  gLeft.addColorStop(1, lighten(d.wall, -.10));
  poly(c, [C, D, up(D,d.H), up(C,d.H)], gLeft);

  const gRight = c.createLinearGradient(0, C[1]-d.H, 0, C[1]);
  gRight.addColorStop(0, lighten(d.wall, .04));
  gRight.addColorStop(1, lighten(d.wall, -.30));
  poly(c, [B, C, up(C,d.H), up(B,d.H)], gRight);

  wallBands(c, B, C, d.H, lighten(d.wall, -.18));
  wallBands(c, D, C, d.H, lighten(d.wall, -.06));

  /* ---- 屋顶 ---- */
  const gRoof = c.createLinearGradient(A[0], A[1]-d.H, C[0], C[1]-d.H);
  gRoof.addColorStop(0, lighten(d.roof, .10));
  gRoof.addColorStop(1, lighten(d.roof, -.16));
  poly(c, [up(A,d.H), up(B,d.H), up(C,d.H), up(D,d.H)], gRoof);

  // 屋顶内圈（女儿墙）
  const inset = 0.16;
  const rA = up(midP(lerpP(A,B,inset), lerpP(A,D,inset)), d.H);
  const rB = up(midP(lerpP(B,A,inset), lerpP(B,C,inset)), d.H);
  const rC = up(midP(lerpP(C,B,inset), lerpP(C,D,inset)), d.H);
  const rD = up(midP(lerpP(D,A,inset), lerpP(D,C,inset)), d.H);
  poly(c, [rA,rB,rC,rD], null);
  c.strokeStyle = 'rgba(0,0,0,.16)'; c.lineWidth = 1.4; c.stroke();

  // 屋顶板缝
  c.strokeStyle = 'rgba(0,0,0,.10)'; c.lineWidth = 1;
  for(let i=1;i<d.w;i++){
    const p1 = up(lerpP(A,B,i/d.w), d.H), p2 = up(lerpP(D,C,i/d.w), d.H);
    c.beginPath(); c.moveTo(p1[0],p1[1]); c.lineTo(p2[0],p2[1]); c.stroke();
  }
  for(let i=1;i<d.h;i++){
    const p1 = up(lerpP(A,D,i/d.h), d.H), p2 = up(lerpP(B,C,i/d.h), d.H);
    c.beginPath(); c.moveTo(p1[0],p1[1]); c.lineTo(p2[0],p2[1]); c.stroke();
  }

  /* ---- 阵营色条：贴屋顶前缘 ---- */
  const e0 = up(lerpP(B,C,.08), d.H), e1 = up(lerpP(B,C,.92), d.H);
  const e2 = up(lerpP(B,C,.92), d.H-5), e3 = up(lerpP(B,C,.08), d.H-5);
  poly(c, [e0,e1,e2,e3], TEAM[owner].accent);

  /* ---- 各类建筑的特征件 ---- */
  if(type === 'yard')     yardExtra(c, d, X, Y, up, B, C, owner);
  if(type === 'barracks') barrackExtra(c, d, X, Y, up, B, C, D, owner);
  if(type === 'refinery') refineryExtra(c, d, X, Y, up, owner);
  if(type === 'power')    powerExtra(c, d, X, Y, up, owner);

  grain(o, 10);
  return { img:o.cv, ax:X(d.w/2,d.h/2), ay:Y(d.w/2,d.h/2), w:W, h:H };
}

/* 墙面上沿墙方向的可重复窗带 */
function wallBands(c, p0, p1, H, color){
  const n = 3, t0 = .12, t1 = .88;
  for(let i=0;i<n;i++){
    const a = lerpP(p0,p1, t0 + (t1-t0)*i/n);
    const b = lerpP(p0,p1, t0 + (t1-t0)*(i+.62)/n);
    const y0 = H*0.42, y1 = H*0.62;
    poly(c, [
      [a[0], a[1]-y0], [b[0], b[1]-y0],
      [b[0], b[1]-y1], [a[0], a[1]-y1],
    ], 'rgba(20,26,26,.42)');
  }
  poly(c, [
    [p0[0], p0[1]-H*0.10], [p1[0], p1[1]-H*0.10],
    [p1[0], p1[1]], [p0[0], p0[1]]
  ], color);
}

/* 屋顶上一个小长方体（设备箱） */
function roofBox(c, X, Y, up, gx, gy, w, h, hh, fill){
  const A=[X(gx,gy),Y(gx,gy)], B=[X(gx+w,gy),Y(gx+w,gy)];
  const C=[X(gx+w,gy+h),Y(gx+w,gy+h)], D=[X(gx,gy+h),Y(gx,gy+h)];
  poly(c,[B,C,up(C,hh),up(B,hh)], lighten(fill,-.22));
  poly(c,[C,D,up(D,hh),up(C,hh)], lighten(fill,.10));
  poly(c,[up(A,hh),up(B,hh),up(C,hh),up(D,hh)], fill);
}

function yardExtra(c, d, X, Y, up, B, C, owner){
  // 机库大门
  const a = up(lerpP(B,C,.18), d.H*0.02), b = up(lerpP(B,C,.72), d.H*0.02);
  poly(c, [
    [a[0], a[1]], [b[0], b[1]],
    [b[0], b[1]-d.H*0.62], [a[0], a[1]-d.H*0.62],
  ], '#242e36');
  c.strokeStyle = 'rgba(255,255,255,.10)';
  c.lineWidth = 1;
  for(let i=1;i<4;i++){
    const y = d.H*0.62*i/4;
    c.beginPath(); c.moveTo(a[0], a[1]-y); c.lineTo(b[0], b[1]-y); c.stroke();
  }
  // 屋顶塔吊
  const cx = X(d.w*0.42, d.h*0.42), cy = Y(d.w*0.42, d.h*0.42);
  c.strokeStyle = '#d8c26a'; c.lineWidth = 3;
  c.beginPath(); c.moveTo(cx, cy-d.H); c.lineTo(cx, cy-d.H-26); c.stroke();
  c.beginPath(); c.moveTo(cx-16, cy-d.H-22); c.lineTo(cx+22, cy-d.H-26); c.stroke();
  c.strokeStyle = '#8b7a3a'; c.lineWidth = 1.4;
  c.beginPath(); c.moveTo(cx+18, cy-d.H-26); c.lineTo(cx+18, cy-d.H-8); c.stroke();
  // 屋顶设备
  roofBox(c, X, Y, up, d.w*0.55, d.h*0.45, .9, .8, 9, '#6b7683');
  roofBox(c, X, Y, up, d.w*0.15, d.h*0.55, .7, .7, 7, '#7a8592');
}

function barrackExtra(c, d, X, Y, up, B, C, D, owner){
  const a = up(lerpP(B,C,.30), 0), b = up(lerpP(B,C,.62), 0);
  poly(c, [
    [a[0], a[1]], [b[0], b[1]],
    [b[0], b[1]-d.H*0.55], [a[0], a[1]-d.H*0.55],
  ], '#2a2418');
  // 旗杆
  const fx = X(d.w*0.75, d.h*0.25), fy = Y(d.w*0.75, d.h*0.25);
  c.strokeStyle = '#b9b2a0'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(fx, fy-d.H); c.lineTo(fx, fy-d.H-22); c.stroke();
  poly(c, [[fx, fy-d.H-22],[fx+13, fy-d.H-18],[fx, fy-d.H-13]], TEAM[owner].accent);
  // 沙袋
  for(let i=0;i<4;i++){
    const p = up(lerpP(D,C,.15+i*.19), 0);
    c.fillStyle = '#8a7d5c';
    c.beginPath(); c.ellipse(p[0], p[1]-3, 7, 4, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1; c.stroke();
  }
}

function refineryExtra(c, d, X, Y, up, owner){
  [[0.28,0.26],[0.66,0.30]].forEach(([gx,gy])=>{
    const cx = X(d.w*gx, d.h*gy), cy = Y(d.w*gx, d.h*gy);
    const rw = 17, hh = d.H*0.85;
    const g = c.createLinearGradient(cx-rw, 0, cx+rw, 0);
    g.addColorStop(0, '#8d9a96'); g.addColorStop(.45, '#c3cecb'); g.addColorStop(1, '#6d7b78');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(cx, cy - hh, rw, rw*0.5, 0, Math.PI, 0);
    c.lineTo(cx+rw, cy);
    c.ellipse(cx, cy, rw, rw*0.5, 0, 0, Math.PI);
    c.closePath(); c.fill();
    c.fillStyle = '#d7e0dd';
    c.beginPath(); c.ellipse(cx, cy-hh, rw, rw*0.5, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1; c.stroke();
    c.strokeStyle = 'rgba(0,0,0,.12)';
    for(let k=1;k<3;k++){
      const y = cy - hh*(1-k/3);
      c.beginPath(); c.ellipse(cx, y, rw, rw*0.5, 0, 0, Math.PI); c.stroke();
    }
  });
  const p1 = [X(d.w*.28, d.h*.26), Y(d.w*.28, d.h*.26)];
  const p2 = [X(d.w*.66, d.h*.30), Y(d.w*.66, d.h*.30)];
  c.strokeStyle = '#93a09c'; c.lineWidth = 5;
  c.beginPath(); c.moveTo(p1[0], p1[1]-d.H*.5); c.lineTo(p2[0], p2[1]-d.H*.5); c.stroke();
}

function powerExtra(c, d, X, Y, up, owner){
  const cx = X(d.w*.5, d.h*.5), cy = Y(d.w*.5, d.h*.5);
  const rwTop = 15, rwBot = 21, hh = d.H + 20;
  const g = c.createLinearGradient(cx-rwBot, 0, cx+rwBot, 0);
  g.addColorStop(0, '#9aa3ad'); g.addColorStop(.5, '#cdd4dc'); g.addColorStop(1, '#767f89');
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(cx, cy-hh, rwTop, rwTop*0.5, 0, Math.PI, 0);
  c.lineTo(cx+rwBot, cy);
  c.ellipse(cx, cy, rwBot, rwBot*0.5, 0, 0, Math.PI);
  c.closePath(); c.fill();
  c.fillStyle = '#e6ebf0';
  c.beginPath(); c.ellipse(cx, cy-hh, rwTop, rwTop*0.5, 0, 0, 7); c.fill();
  c.fillStyle = 'rgba(30,40,50,.45)';
  c.beginPath(); c.ellipse(cx, cy-hh, rwTop*.62, rwTop*.31, 0, 0, 7); c.fill();
  c.strokeStyle = 'rgba(30,36,30,.7)'; c.lineWidth = 1.6;
  c.beginPath(); c.moveTo(cx+rwBot*.7, cy-4); c.lineTo(X(d.w*.92, d.h*.9), Y(d.w*.92, d.h*.9)-4); c.stroke();
}

/* =========================================================================
   单位
   -------------------------------------------------------------------------
   载具（坦克/采矿车）：按"俯视"画，再压扁 0.5 并旋转 —— 等距立体感。
     为了不显得像纸片，分多层烘焙：侧壁（深色剪影，往下偏移）→ 顶面。
   步兵：不用压扁，直接画"竖立的小人"，像红警里的立绘。
   ========================================================================= */
function bakeUnit(type, owner, dir){
  if(type === 'inf') return bakeInf(owner, dir);

  const u = UNIT[type];
  const pad = 14;
  const W = u.len + pad*2, H = u.wid*0.5 + pad*2 + 20;
  const o = mk(W,H), c = o.c;
  const cx = W/2, cy = H - pad - 8;
  const a = dir/DIRS*Math.PI*2;

  const pass = (dy, fn)=>{
    c.save();
    c.translate(cx, cy+dy);
    c.scale(1, 0.5);
    c.rotate(a);
    fn();
    c.restore();
  };

  if(type === 'tank'){
    pass(6, ()=> tankBase(c, u));          // 履带+车体侧壁
    pass(3, ()=> tankHull(c, u, owner));   // 车体顶
    pass(7, ()=> tankTurret(c, u, owner, true));  // 炮塔侧壁
    pass(1, ()=> tankTurret(c, u, owner, false)); // 炮塔顶
  } else {
    pass(5, ()=> harvBase(c, u));
    pass(2, ()=> harvTop(c, u, owner));
  }

  grain(o, 7);
  return { img:o.cv, ax:cx, ay:cy, w:W, h:H };
}

/* --- 坦克 --- */
function tankBase(c, u){
  const L = u.len, Wd = u.wid;
  c.fillStyle = '#262a20';
  rr(c, -L*.46, -Wd*.48, L*.92, Wd*.28, 3); c.fill();
  rr(c, -L*.46,  Wd*.20, L*.92, Wd*.28, 3); c.fill();
  c.fillStyle = '#454c37';
  rr(c, -L*.46, -Wd*.32, L*.92, Wd*.64, 4); c.fill();
}
function tankHull(c, u, owner){
  const L = u.len, Wd = u.wid;
  const g = c.createLinearGradient(0,-Wd*.3,0,Wd*.3);
  g.addColorStop(0, '#94a06e'); g.addColorStop(.5, '#79825a'); g.addColorStop(1, '#5c6544');
  c.fillStyle = g;
  rr(c, -L*.44, -Wd*.28, L*.86, Wd*.56, 4); c.fill();
  // 顶面高光边
  c.strokeStyle = 'rgba(230,240,190,.4)'; c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(-L*.40, -Wd*.26); c.lineTo(L*.38, -Wd*.26);
  c.stroke();
  c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1;
  rr(c, -L*.44, -Wd*.28, L*.86, Wd*.56, 4); c.stroke();
  // 履带齿
  c.fillStyle = 'rgba(255,255,255,.08)';
  for(let i=0;i<7;i++){
    const x = -L*.42 + i*L*.125;
    c.fillRect(x, -Wd*.47, 3, Wd*.26);
    c.fillRect(x,  Wd*.21, 3, Wd*.26);
  }
  // 阵营色条
  c.fillStyle = TEAM[owner].accent;
  c.fillRect(-L*.12, -Wd*.26, L*.14, Wd*.52);
}
function tankTurret(c, u, owner, dark){
  const L = u.len, Wd = u.wid;
  if(dark){
    c.fillStyle = '#3a4130';
    c.beginPath(); c.arc(-L*.02, 0, Wd*.32, 0, 7); c.fill();
    c.fillRect(L*.02, -3, L*.40, 6);
    return;
  }
  c.fillStyle = '#707b52';
  c.beginPath(); c.arc(-L*.02, 0, Wd*.30, 0, 7); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1; c.stroke();
  c.strokeStyle = 'rgba(235,245,200,.35)';
  c.beginPath(); c.arc(-L*.02, 0, Wd*.24, Math.PI*.9, Math.PI*1.9); c.stroke();
  c.fillStyle = '#4c553c';
  c.fillRect(L*.02, -2.6, L*.40, 5.2);
  c.fillStyle = '#23271d';
  c.fillRect(L*.36, -3.4, 5, 6.8);
  c.fillStyle = '#87926a';
  c.beginPath(); c.arc(-L*.12, -Wd*.07, 4.6, 0, 7); c.fill();
  c.fillStyle = TEAM[owner].emblem;
  c.beginPath(); c.arc(-L*.12, -Wd*.07, 1.9, 0, 7); c.fill();
}

/* --- 采矿车 --- */
function harvBase(c, u){
  const L = u.len, Wd = u.wid;
  c.fillStyle = '#1f211c';
  [[-L*.30,-Wd*.46],[-L*.30,Wd*.30],[ L*.24,-Wd*.46],[L*.24,Wd*.30]].forEach(([x,y])=>{
    rr(c, x, y, L*.18, Wd*.16, 2); c.fill();
  });
  c.fillStyle = '#4c422a';
  rr(c, -L*.48, -Wd*.36, L*.64, Wd*.72, 3); c.fill();
}
function harvTop(c, u, owner){
  const L = u.len, Wd = u.wid;
  const A = TEAM[owner];
  // 料斗
  c.fillStyle = '#6f5f38';
  rr(c, -L*.46, -Wd*.34, L*.62, Wd*.68, 3); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; c.stroke();
  // 矿石
  c.fillStyle = '#d9ae4a';
  rr(c, -L*.42, -Wd*.28, L*.54, Wd*.56, 2); c.fill();
  c.fillStyle = 'rgba(255,240,180,.55)';
  for(let i=0;i<6;i++){
    const x = -L*.40 + Math.random()*L*.5;
    const y = -Wd*.22 + Math.random()*Wd*.44;
    c.fillRect(x, y, 3, 2.4);
  }
  // 驾驶室
  c.fillStyle = A.accent;
  rr(c, L*.18, -Wd*.30, L*.26, Wd*.60, 3); c.fill();
  c.fillStyle = 'rgba(180,225,255,.75)';
  rr(c, L*.22, -Wd*.22, L*.15, Wd*.44, 2); c.fill();
  c.fillStyle = '#3d4436';
  c.fillRect(L*.44, -2.4, 4, 4.8);
}

/* --- 步兵：竖立小人，两个朝向 --- */
function bakeInf(owner, dir){
  const o = mk(26, 36), c = o.c;
  const cx = 13, base = 31;
  const A = TEAM[owner];
  const flip = dir >= 8;             // 屏幕上朝左还是朝右
  c.save();
  c.translate(cx, base);
  if(flip) c.scale(-1, 1);

  // 腿
  c.strokeStyle = '#3a3f30'; c.lineWidth = 2.6;
  c.beginPath(); c.moveTo(-1.5, -8); c.lineTo(-2.5, -1); c.stroke();
  c.beginPath(); c.moveTo(2.5, -8);  c.lineTo(3.5, -1);  c.stroke();
  // 靴子
  c.fillStyle = '#23261e';
  c.fillRect(-4.5, -2, 4, 2.4); c.fillRect(1.5, -2, 4, 2.4);
  // 身体
  const g = c.createLinearGradient(0,-16,0,-7);
  g.addColorStop(0, lighten(A.body, .18));
  g.addColorStop(1, lighten(A.body, -.18));
  c.fillStyle = g;
  rr(c, -4.5, -16.5, 9, 10, 3); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1; c.stroke();
  // 背带
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(-2, -16); c.lineTo(1, -8); c.stroke();
  // 头
  c.fillStyle = '#c9a382';
  c.beginPath(); c.arc(0, -19.5, 3.2, 0, 7); c.fill();
  // 头盔
  c.fillStyle = lighten(A.body, -.05);
  c.beginPath(); c.arc(0, -20, 3.6, Math.PI*1.05, Math.PI*2.1); c.fill();
  c.beginPath(); c.ellipse(0, -19.4, 4, 1.4, 0, 0, 7); c.fill();
  // 枪
  c.strokeStyle = '#26291f'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(1, -11); c.lineTo(9.5, -8.5); c.stroke();
  c.strokeStyle = '#4a4f3f'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(4, -10.5); c.lineTo(5.5, -12.5); c.stroke();

  c.restore();
  grain(o, 6);
  return { img:o.cv, ax:cx, ay:base, w:26, h:36 };
}

/* =========================================================================
   场景装饰
   ========================================================================= */
function bakeTree(v){
  const o = mk(52, 66), c = o.c;
  const cx = 26, base = 58;
  c.fillStyle = '#4a3b28';
  c.fillRect(cx-2.5, base-16, 5, 16);
  const blobs = [
    [cx,      base-34, 16.5, '#3f5c33'],
    [cx-7+v,  base-40, 12.5, '#4c6d3b'],
    [cx+6,    base-30, 11.5, '#37512d'],
  ];
  for(const [x,y,r,col] of blobs){
    c.fillStyle = col;
    c.beginPath(); c.ellipse(x, y, r, r*0.82, 0, 0, 7); c.fill();
  }
  c.fillStyle = 'rgba(150,190,110,.35)';
  c.beginPath(); c.ellipse(cx-8, base-44, 7, 5, -.3, 0, 7); c.fill();
  c.fillStyle = 'rgba(0,0,0,.22)';
  c.beginPath(); c.ellipse(cx+4, base+2, 15, 6, 0, 0, 7); c.fill();
  grain(o, 14);
  return { img:o.cv, ax:cx, ay:base, w:52, h:66 };
}

function bakeRock(v){
  const o = mk(44, 40), c = o.c;
  const cx = 22, base = 32;
  c.fillStyle = 'rgba(0,0,0,.22)';
  c.beginPath(); c.ellipse(cx+2, base, 14, 5.5, 0, 0, 7); c.fill();
  const pts = [[cx-13,base],[cx-9,base-11],[cx+1,base-16],[cx+10,base-9],[cx+13,base]];
  poly(c, pts, '#6d6f66');
  poly(c, [[cx-9,base-11],[cx+1,base-16],[cx+3,base-8],[cx-6,base-6]], '#8b8d82');
  poly(c, [[cx+3,base-8],[cx+10,base-9],[cx+13,base],[cx+4,base]], '#55574f');
  grain(o, 18);
  return { img:o.cv, ax:cx, ay:base, w:44, h:40 };
}

function bakeOre(v){
  const o = mk(64, 36), c = o.c;
  poly(c, [[32,2],[62,18],[32,34],[2,18]], 'rgba(70,58,34,.55)');
  const seeds = [[18,20,6],[30,24,8],[44,18,6],[36,13,5],[24,14,4]];
  for(let i=0;i<seeds.length;i++){
    const [x,y,r] = seeds[(i+v)%seeds.length];
    poly(c, [[x,y-r],[x+r*.62,y],[x,y+r*.5],[x-r*.62,y]], '#c79a34');
    poly(c, [[x,y-r],[x+r*.62,y],[x,y+r*.5]], '#efc75e');
    poly(c, [[x,y-r],[x-r*.62,y],[x,y+r*.5]], '#a87d24');
  }
  return { img:o.cv, ax:32, ay:18, w:64, h:36 };
}

/* =========================================================================
   对外接口
   ========================================================================= */
const cache = { bld:{}, unit:{}, prop:{}, ore:[] };

function build(){
  for(const t of Object.keys(BLD)){
    cache.bld[t] = [ bakeBuilding(t,0), bakeBuilding(t,1) ];
  }
  cache.unit.inf = [ [], [] ];
  for(let owner=0; owner<2; owner++)
    for(let d=0; d<DIRS; d++) cache.unit.inf[owner].push(bakeInf(owner, d));
  for(const t of ['tank','harv']){
    cache.unit[t] = [ [], [] ];
    for(let owner=0; owner<2; owner++)
      for(let d=0; d<DIRS; d++) cache.unit[t][owner].push(bakeUnit(t, owner, d));
  }
  for(let v=0; v<3; v++){
    cache.prop['tree'+v] = bakeTree(v);
    cache.prop['rock'+v] = bakeRock(v);
    cache.ore.push(bakeOre(v));
  }
}

return {
  BLD, UNIT, DIRS, build,
  bld: (t, owner)=> cache.bld[t][owner],
  unit: (t, owner, dir)=> cache.unit[t][owner][((dir%DIRS)+DIRS)%DIRS],
  prop: (k)=> cache.prop[k],
  ore: (v)=> cache.ore[v%3],
};

})();
