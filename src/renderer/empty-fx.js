'use strict';

// 首页空状态动效：蜂群漩涡（swarm vortex）+ 数据流吸入中心。
//
// 设计意图：BT 的 swarm 就是一簇互相连着的节点，所以用「环绕徽标公转的粒子 +
// 从外圈螺旋吸入中心的数据流」来表现"正在把资源吸进来"。
//
// 性能：粒子用预渲染的精灵（离屏 canvas）绘制，避免每帧 createRadialGradient；
// 窗口不可见 / 没有空状态时自动停 RAF。
//
// 说明：本机 macOS 开了「减弱动态效果」，但用户明确要动效，所以不静止，只降档。
// 想彻底关掉：localStorage.setItem('mt-fx', 'off')

(function () {
  const TAU = Math.PI * 2;

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const C1 = hexToRgb('#6fdcff'); // 青
  const C2 = hexToRgb('#2d7ff9'); // 蓝
  const C3 = hexToRgb('#35e0a1'); // 绿
  const HOT_CORE = hexToRgb('#fff3c4'); // 撞击火光：白热核心
  const HOT_EDGE = hexToRgb('#ff8a3d'); // 撞击火光：橙色余烬

  function lerp(a, b, t) { return a + (b - a) * t; }

  function makeSprite(color, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const half = size / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},1)`);
    grad.addColorStop(0.32, `rgba(${color[0]},${color[1]},${color[2]},0.6)`);
    grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(half, half, half, 0, TAU);
    g.fill();
    return c;
  }

  class SwarmVortex {
    constructor(canvas, frontCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.front = frontCanvas || null;
      this.fctx = frontCanvas ? frontCanvas.getContext('2d') : null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.raf = null;
      this.running = false;
      this.last = 0;
      this.t = 0;
      this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };

      this.calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.disabled = (() => { try { return localStorage.getItem('mt-fx') === 'off'; } catch { return false; } })();

      this.sprites = [makeSprite(C1, 48), makeSprite(C2, 48), makeSprite(C3, 48)];
      this.hotSprites = [makeSprite(HOT_CORE, 48), makeSprite(HOT_EDGE, 48)];

      this.orbiters = [];
      this.streams = [];
      this.comets = [];
      this.flashes = [];   // 被 logo"吞噬"时的闪一下
      this.flashCount = 0;

      this.resize();
      this.build();

      this.onResize = () => { this.resize(); this.build(); };
      window.addEventListener('resize', this.onResize);

      this.onMove = (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
        this.pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      };
      window.addEventListener('pointermove', this.onMove, { passive: true });
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      this.w = w;
      this.h = h;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.front) {
        this.front.width = Math.floor(w * this.dpr);
        this.front.height = Math.floor(h * this.dpr);
        this.fctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      }
      this.cx = w / 2;
      this.cy = h / 2;
      this.base = Math.min(w, h);
      this.logoR = 46;
      this.measureLogo();
    }

    /** 把漩涡中心对齐到页面上的 logo（它在画布里偏上，不能用画布中心） */
    measureLogo() {
      try {
        const mark = document.querySelector('.empty-mark');
        const canvasRect = this.canvas.getBoundingClientRect();
        if (mark) {
          const r = mark.getBoundingClientRect();
          if (r.width > 0) {
            this.cx = r.x + r.width / 2 - canvasRect.x;
            this.cy = r.y + r.height / 2 - canvasRect.y;
            this.logoR = r.width / 2;
          }
        }
      } catch { /* 没有 logo 元素时退回画布中心 */ }
    }

    build() {
      const base = this.base;
      const inner = Math.max(70, base * 0.15); // 徽标半径，粒子别压住 logo
      this.innerR = inner;
      const outer = base * 0.66;
      const scale = this.calm ? 0.66 : 1;

      // 公转粒子：3 层椭圆轨道，且缓慢向内漂移（汇聚感）
      this.orbiters = [];
      const layers = [
        { count: 38, r0: inner * 1.15, r1: inner * 1.95, radPerSec: 0.55, drift: 2.2, size: 0.75, alpha: 0.72 },
        { count: 30, r0: inner * 2.0, r1: inner * 3.2, radPerSec: 0.36, drift: 3.0, size: 1.0, alpha: 0.52 },
        { count: 24, r0: inner * 3.3, r1: outer, radPerSec: 0.24, drift: 4.0, size: 1.35, alpha: 0.34 }
      ];
      for (const L of layers) {
        const count = Math.round(L.count * scale);
        for (let i = 0; i < count; i++) {
          const radius = lerp(L.r0, L.r1, Math.random());
          this.orbiters.push({
            radius,
            r0: L.r0,
            r1: L.r1,
            angle: Math.random() * TAU,
            radPerSec: L.radPerSec * (0.7 + Math.random() * 0.8) * (Math.random() < 0.5 ? 1 : -1),
            drift: L.drift * (0.6 + Math.random() * 0.8),
            tilt: 0.34 + Math.random() * 0.42,
            size: L.size * (0.7 + Math.random() * 0.9),
            alpha: L.alpha * (0.55 + Math.random() * 0.65),
            colorIdx: Math.random() < 0.55 ? 0 : (Math.random() < 0.6 ? 1 : 2),
            wobble: Math.random() * TAU,
            wobblePerSec: 0.4 + Math.random() * 0.9
          });
        }
      }

      // 螺旋数据流：从外圈一路卷进中心，带渐隐拖尾
      this.streams = [];
      const streamCount = Math.max(10, Math.round((base / 20) * scale));
      for (let i = 0; i < streamCount; i++) this.streams.push(this.spawnStream(true));

      // 彗星：少数几颗大粒子 + 长拖尾，作为视觉主心骨
      this.comets = [];
      for (let i = 0; i < 4; i++) {
        this.comets.push({
          angle: Math.random() * TAU,
          radius: inner * (2.2 + Math.random() * 3.0),
          radPerSec: (0.5 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1),
          drift: 12 + Math.random() * 8,
          tilt: 0.3 + Math.random() * 0.5,
          size: 1.5 + Math.random() * 0.9,
          colorIdx: Math.random() < 0.6 ? 0 : 2,
          trail: []
        });
      }
    }

    spawnStream(anywhere) {
      const base = this.base;
      const inner = this.innerR;
      return {
        angle: Math.random() * TAU,
        radius: anywhere ? base * (0.2 + Math.random() * 0.45) : base * (0.5 + Math.random() * 0.14),
        // 真正会动的径向速度（px/秒）——之前按 0.0016 px/帧 算，几乎不动
        radialSpeed: 26 + Math.random() * 58,
        angularSpeed: 0.35 + Math.random() * 0.55,
        size: 0.7 + Math.random() * 1.1,
        colorIdx: Math.random() < 0.5 ? 0 : 2,
        alpha: 0.55 + Math.random() * 0.45,
        tilt: 0.5 + Math.random() * 0.4,
        trail: [],
        inner: this.logoR * (1.04 + Math.random() * 0.18)
      };
    }

    start() {
      if (this.running || this.disabled) return;
      this.running = true;
      this.canvas.classList.add('fx-on');
      this.last = 0;
      const loop = (ts) => {
        if (!this.running) return;
        const dt = Math.min(50, this.last ? ts - this.last : 16);
        this.last = ts;
        this.t += dt;
        this.step(dt);
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.canvas.classList.remove('fx-on');
    }

    step(dt) {
      const s = dt / 1000; // 秒
      this.pointer.x += (this.pointer.tx - this.pointer.x) * 0.05;
      this.pointer.y += (this.pointer.ty - this.pointer.y) * 0.05;

      // 公转 + 缓慢内漂
      for (const p of this.orbiters) {
        p.angle += p.radPerSec * s;
        p.wobble += p.wobblePerSec * s;
        p.radius -= p.drift * s;
        if (p.radius <= p.r0 * 0.9) p.radius = p.r1;
      }

      // 螺旋流：角速度 + 径向速度 + 拖尾采样
      // 黑洞效果：越接近中心，被"吸"得越快（径向和角向同时加速）
      for (let i = 0; i < this.streams.length; i++) {
        const st = this.streams[i];
        const pull = Math.min(1, Math.max(0, 1 - st.radius / (this.base * 0.45)));
        // 最后 35% 再补一段"猛地被吸进去"的加速度
        const sinkPull = st.radius < this.innerR * 2.2
          ? 1 + (1 - st.radius / (this.innerR * 2.2)) * 5.5
          : 1;
        const boost = (1 + pull * pull * 3.4) * sinkPull;
        st.angle += st.angularSpeed * boost * s;
        st.radius -= st.radialSpeed * boost * s;
        st.trail.push({ a: st.angle, r: st.radius });
        if (st.trail.length > 8) st.trail.shift();
        if (st.radius <= st.inner) {
          const fx = this.positionOf(st.angle, st.radius, st.tilt);
          this.addFlash(fx.x, fx.y, st.colorIdx, 0.9 + Math.random() * 0.5);
          this.streams[i] = this.spawnStream(false);
        }
      }

      // 兜底：一帧跨太多步导致越过边界的，立刻补一次湮灭
      for (const st of this.streams) {
        if (st.radius < this.logoR * 0.9) {
          const fx = this.positionOf(st.angle, Math.max(st.radius, this.logoR), st.tilt);
          this.addFlash(fx.x, fx.y, st.colorIdx, 1);
          st.radius = this.innerR;
        }
      }

      // 湮灭闪光推进
      for (let i = this.flashes.length - 1; i >= 0; i--) {
        const f = this.flashes[i];
        f.age += dt;
        if (f.age >= f.life) this.flashes.splice(i, 1);
      }

      // 彗星
      for (const c of this.comets) {
        c.angle += c.radPerSec * s;
        c.radius -= c.drift * s;
        if (c.radius < this.logoR * 1.05) {
          const fx = this.positionOf(c.angle, c.radius, c.tilt);
          this.addFlash(fx.x, fx.y, c.colorIdx, 1.4);
          c.radius = this.base * 0.6;
        }
        c.trail.push({ a: c.angle, r: c.radius });
        if (c.trail.length > 18) c.trail.shift();
      }
    }

    positionOf(angle, radius, tilt) {
      return {
        x: this.cx + Math.cos(angle) * radius,
        y: this.cy + Math.sin(angle) * radius * tilt
      };
    }

    addFlash(x, y, colorIdx, power) {
      // 控制数量，避免刷屏
      if (this.flashes.length > 14) this.flashes.shift();
      const sparks = [];
      for (let i = 0; i < 8; i++) {
        sparks.push({
          a: Math.random() * TAU,
          v: 60 + Math.random() * 150,      // px/秒
          r: 1 + Math.random() * 1.8
        });
      }
      this.flashes.push({
        x, y, colorIdx, power, sparks,
        age: 0,
        life: 380 + Math.random() * 220
      });
      this.flashCount += 1;
    }

    /** 文字区压暗系数：粒子仍然经过，但不会盖住标题 */
    zoneAlpha(x, y, cxx, cyy) {
      const dx = (x - cxx) / (this.base * 0.46);
      const dy = (y - (cyy + this.base * 0.36)) / (this.base * 0.26);
      const d = dx * dx + dy * dy;
      if (d < 1) return 0.18 + 0.42 * d;
      return 1;
    }

    draw() {
      let ctx = this.ctx;
      const { w, h, cx, cy } = this;
      const base = this.base;

      // 每帧清空：之前的半透明覆盖会在背景上留下"水印"似的残影，去掉
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';
      // 不再加视差偏移：视差会让粒子绕的中心和 logo 中心错开 14px，看着像穿过图标没湮灭
      const cxx = cx;
      const cyy = cy;

      // 中心辉光
      const pulse = 0.55 + 0.45 * Math.sin(this.t * 0.00286);   // 与光晕呼吸同周期（约 2.2s）
      const glowR = base * (0.22 + 0.03 * pulse);
      const grad = ctx.createRadialGradient(cxx, cyy, 0, cxx, cyy, glowR);
      grad.addColorStop(0, `rgba(255,205,120,${0.20 * pulse + 0.05})`);
      grad.addColorStop(0.45, `rgba(255,140,80,${0.10 * pulse})`);
      grad.addColorStop(0.7, `rgba(255,110,90,${0.04 * pulse})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cxx, cyy, glowR, 0, TAU);
      ctx.fill();

      // 公转粒子
      for (const p of this.orbiters) {
        const r = p.radius * (1 + Math.sin(p.wobble) * 0.035);
        const x = cxx + Math.cos(p.angle) * r;
        const y = cyy + Math.sin(p.angle) * r * p.tilt;
        const sprite = this.sprites[p.colorIdx];
        const size = p.size * 9;
        ctx.globalAlpha = Math.min(1, p.alpha * 0.9 * this.zoneAlpha(x, y, cxx, cyy));
        ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
      }

      // 螺旋数据流：拖尾折线 + 头部
      for (const st of this.streams) {
        const sprite = this.sprites[st.colorIdx];
        const fadeHead = Math.min(1, st.radius / (base * 0.5));
        const pull = Math.min(1, Math.max(0, 1 - st.radius / (base * 0.45)));
        const heat = 0.55 + 0.45 * pull;   // 越靠内越亮
        // 拖尾
        if (st.trail.length > 1) {
          ctx.beginPath();
          for (let i = 0; i < st.trail.length; i++) {
            const t = st.trail[i];
            const x = cxx + Math.cos(t.a) * t.r;
            const y = cyy + Math.sin(t.a) * t.r * st.tilt;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = st.colorIdx === 0 ? 'rgba(111,220,255,0.55)' : 'rgba(53,224,161,0.5)';
          ctx.lineWidth = 1.1;
          ctx.globalAlpha = 0.22 * fadeHead;
          ctx.stroke();
        }
        const x = cxx + Math.cos(st.angle) * st.radius;
        const y = cyy + Math.sin(st.angle) * st.radius * st.tilt;
        const size = st.size * 11;
        const sink = Math.min(1, Math.max(0, (st.radius - st.inner * 0.45) / (st.inner * 0.8)));
        ctx.globalAlpha = st.alpha * heat * sink * this.zoneAlpha(x, y, cxx, cyy);
        const drawSize = size * (1 + pull * 0.55);
        ctx.drawImage(sprite, x - drawSize / 2, y - drawSize / 2, drawSize, drawSize);
      }

      // 彗星（长拖尾）
      for (const c of this.comets) {
        const sprite = this.sprites[c.colorIdx];
        for (let i = 0; i < c.trail.length; i++) {
          const t = c.trail[i];
          const k = i / c.trail.length;
          const x = cxx + Math.cos(t.a) * t.r;
          const y = cyy + Math.sin(t.a) * t.r * c.tilt;
          const size = c.size * (2.5 + k * 5);
          ctx.globalAlpha = (0.02 + k * 0.26) * this.zoneAlpha(x, y, cxx, cyy);
          ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
        }
        const x = cxx + Math.cos(c.angle) * c.radius;
        const y = cyy + Math.sin(c.angle) * c.radius * c.tilt;
        const size = c.size * 11;
        ctx.globalAlpha = 0.85 * this.zoneAlpha(x, y, cxx, cyy);
        ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
      }

      // 湮灭 = 高温粒子砸在 logo 上的火光：画在独立的上层画布，盖在 logo 前面
      const flashCtx = this.fctx || ctx;
      if (this.fctx) {
        this.fctx.globalCompositeOperation = 'source-over';
        this.fctx.clearRect(0, 0, w, h);
        this.fctx.globalCompositeOperation = 'lighter';
      }
      for (const f of this.flashes) {
        ctx = flashCtx;
        const k = f.age / f.life;                 // 0 → 1
        const ease = 1 - Math.pow(1 - k, 2.4);
        const t = f.age / 1000;

        const coreSize = (9 + ease * 24) * f.power;
        ctx.globalAlpha = Math.pow(1 - k, 1.6);
        ctx.drawImage(this.hotSprites[0], f.x - coreSize / 2, f.y - coreSize / 2, coreSize, coreSize);

        const emberSize = (14 + ease * 42) * f.power;
        ctx.globalAlpha = Math.pow(1 - k, 1.9) * 0.7;
        ctx.drawImage(this.hotSprites[1], f.x - emberSize / 2, f.y - emberSize / 2, emberSize, emberSize);

        // 冲击环
        const ringR = (2 + ease * 9) * f.power;
        ctx.beginPath();
        ctx.arc(f.x, f.y, ringR, 0, TAU);
        ctx.strokeStyle = `rgba(255,${Math.round(160 + 80 * (1 - k))},${Math.round(80 + 80 * (1 - k))},0.7)`;
        ctx.lineWidth = Math.max(0.4, 1.8 * (1 - k));
        ctx.globalAlpha = Math.pow(1 - k, 1.4) * 0.55;
        ctx.stroke();

        // 飞溅火星
        for (const sp of f.sparks) {
          const d = sp.v * t;
          const px = f.x + Math.cos(sp.a) * d;
          const py = f.y + Math.sin(sp.a) * d * 0.9;
          const size = sp.r * (1 - k) * 4.2;
          if (size <= 0.3) continue;
          ctx.globalAlpha = Math.pow(1 - k, 1.8);
          ctx.drawImage(this.hotSprites[1], px - size / 2, py - size / 2, size, size);
          // 火星的短尾
          ctx.globalAlpha = Math.pow(1 - k, 2) * 0.5;
          ctx.strokeStyle = 'rgba(255,170,80,0.9)';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - Math.cos(sp.a) * 7, py - Math.sin(sp.a) * 6);
          ctx.stroke();
        }
      }

      flashCtx.globalAlpha = 1;
      flashCtx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 1;
      this.ctx.globalCompositeOperation = 'source-over';
    }

    destroy() {
      this.stop();
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('pointermove', this.onMove);
    }
  }

  window.SwarmVortex = SwarmVortex;
})();
