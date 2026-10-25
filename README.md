# LingGame

一个目录一个游戏。当前两条线：

## `wordtower/` — 文字塔防（主线）

单文件 canvas 游戏，720×1446 竖屏，1v1 上下分屏双线对攻。

| 文件 | 作用 |
|---|---|
| `WordTower.html` | 游戏本体（单文件，含全部逻辑与渲染） |
| `server.js` | 联机转发服务器：静态托管 + 手写 WebSocket + 房间配对 + 录像落盘 |
| `headless.js` | 无界面数据模式：给 agent 读快照 / 下命令 / 跑自对弈 / 重放存档 |
| `test-pool.js` | 字池规则验证脚本 |
| `docs/headless-mode-plan.md` | headless 改造方案 |
| `records/` | 对局存档（不入 git） |

跑法：

```bash
node wordtower/server.js                 # 联机版，默认 8787 → http://localhost:8787/
node wordtower/headless.js --selfplay 5  # 两边 bot 自对弈 5 局
node wordtower/test-pool.js              # 字池规则验证
```

三个脚本都用 `__dirname` 定位，在仓库根或 `wordtower/` 内跑都行。

## `rts/` — 红警类 RTS（学习线）

目标是做即时战略，技术路线是先用 HTML/Canvas 验证玩法，玩法稳定或撞到性能瓶颈后再迁 Godot 4。

| 文件 | 作用 |
|---|---|
| `index.html` | 当前版本：等距投影、30Hz 固定 tick + 插值、框选、相机推边缩放 |
| `sprites.js` | 程序化烘焙的等距素材（启动时画进离屏 canvas，渲染只 drawImage） |
| `reference/IronFront.html` | 早期单文件原型，仅作参考，不继续开发 |

浏览器直接打开 `rts/index.html` 即可。

迁移 Godot 前必须守住的三条：世界状态是纯数据（render 只读）、固定 tick 跑逻辑、兵种/建筑/数值外置到 JSON 表。
