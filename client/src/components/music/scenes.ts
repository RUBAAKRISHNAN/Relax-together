import type { MoodId } from '@shared/constants';

/**
 * Canvas scenes for music-room moods. Each factory builds its particles and pre-renders static
 * scenery (hills, trees, moon…) once per resize as a separate backdrop layer; per frame it only
 * moves and draws lightweight particles, batched into as few paths as possible.
 * `energy` (0..1) comes from the music when available and gently drives intensity.
 */

export interface Frame {
  w: number;
  h: number;
  /** Seconds since the scene started. */
  t: number;
  /** Seconds since the previous frame (clamped). */
  dt: number;
  energy: number;
}

export type Draw = (ctx: CanvasRenderingContext2D, f: Frame) => void;

/** A static backdrop (painted once per resize, on its own layer) plus the per-frame animation. */
export interface Scene {
  backdrop: HTMLCanvasElement | null;
  draw: Draw;
}
type Factory = (w: number, h: number) => Scene;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
/** Particle count that scales with screen area, within sane bounds. */
const count = (w: number, h: number, perPixel: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, (w * h) / perPixel)));

function layer(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  paint(c.getContext('2d')!);
  return c;
}

const spriteCache = new Map<string, HTMLCanvasElement>();
/** Soft round glow, cached per color/size (much cheaper than shadowBlur). */
function glow(color: string, size: number): HTMLCanvasElement {
  const key = `${color}|${size}`;
  let s = spriteCache.get(key);
  if (!s) {
    s = layer(size * 2, size * 2, (ctx) => {
      const g = ctx.createRadialGradient(size, size, 0, size, size, size);
      g.addColorStop(0, color);
      g.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.35)'));
      g.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size * 2, size * 2);
    });
    spriteCache.set(key, s);
  }
  return s;
}

function hills(ctx: CanvasRenderingContext2D, w: number, h: number, base: number, amp: number, color: string, seed: number) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w + 20; x += 20) {
    const y = base + Math.sin(x / 260 + seed) * amp + Math.sin(x / 97 + seed * 2) * amp * 0.35;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------- 🌸 Cherry Blossom

const calm: Factory = (w, h) => {
  const scenery = layer(w, h, (ctx) => {
    const sun = ctx.createRadialGradient(w * 0.18, h * 0.16, 0, w * 0.18, h * 0.16, Math.max(w, h) * 0.55);
    sun.addColorStop(0, 'rgba(255,255,255,0.75)');
    sun.addColorStop(0.25, 'rgba(255,240,245,0.25)');
    sun.addColorStop(1, 'rgba(255,240,245,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);
    hills(ctx, w, h, h * 0.72, h * 0.05, 'rgba(196,160,214,0.55)', 1.3);
    hills(ctx, w, h, h * 0.8, h * 0.04, 'rgba(170,135,200,0.65)', 4.1);
    hills(ctx, w, h, h * 0.88, h * 0.03, 'rgba(140,105,175,0.8)', 7.7);

    // A blossoming branch reaching in from the top-right corner.
    const branch = (x: number, y: number, angle: number, len: number, width: number, depth: number) => {
      const x2 = x + Math.cos(angle) * len;
      const y2 = y + Math.sin(angle) * len;
      ctx.strokeStyle = 'rgba(92,58,70,0.9)';
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo((x + x2) / 2 + rand(-12, 12), (y + y2) / 2 + rand(-12, 12), x2, y2);
      ctx.stroke();
      if (depth > 0) {
        branch(x2, y2, angle + rand(0.2, 0.55), len * rand(0.6, 0.75), width * 0.65, depth - 1);
        branch(x2, y2, angle - rand(0.2, 0.55), len * rand(0.55, 0.7), width * 0.6, depth - 1);
      }
      if (depth < 3) {
        for (let i = 0; i < 9; i++) {
          ctx.fillStyle = pick(['rgba(255,183,205,0.95)', 'rgba(255,205,222,0.95)', 'rgba(250,160,190,0.9)', 'rgba(255,230,238,0.95)']);
          ctx.beginPath();
          ctx.arc(x2 + rand(-16, 16), y2 + rand(-14, 14), rand(3, 7), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    const scale = Math.min(w, h) / 800;
    branch(w + 10, -10, Math.PI * 0.78, 210 * scale + 60, 16 * scale + 4, 5);
  });

  const colors = ['#ffc1d6', '#ffb0c9', '#ffd6e5', '#fbcfe0', '#ff9fbe'];
  const petals = Array.from({ length: count(w, h, 15000, 30, 120) }, () => ({
    x: rand(-20, w),
    y: rand(-h, h),
    s: rand(4, 10),
    rot: rand(0, Math.PI * 2),
    vr: rand(-1.6, 1.6),
    vx: rand(10, 35),
    vy: rand(22, 55),
    phase: rand(0, Math.PI * 2),
    color: pick(colors),
  }));

  return {
    backdrop: scenery,
    draw: (ctx, f) => {
      const wind = 14 + Math.sin(f.t * 0.25) * 18 + f.energy * 45;
      for (const p of petals) {
        p.x += (p.vx + wind) * f.dt + Math.sin(f.t * 1.4 + p.phase) * 18 * f.dt;
        p.y += p.vy * f.dt;
        p.rot += p.vr * f.dt;
        if (p.y > h + 20 || p.x > w + 30) {
          p.y = rand(-60, -10);
          p.x = rand(-w * 0.3, w);
        }
        const flip = 0.35 + 0.65 * Math.abs(Math.sin(p.rot * 1.7 + p.phase));
        const c = Math.cos(p.rot);
        const s = Math.sin(p.rot);
        ctx.setTransform(c, s, -s * flip, c * flip, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(0, -p.s);
        ctx.quadraticCurveTo(p.s, -p.s * 0.1, 0, p.s);
        ctx.quadraticCurveTo(-p.s, -p.s * 0.1, 0, -p.s);
        ctx.fill();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
  };
};

// ---------------------------------------------------------------- 🌧️ Rainy Window

const rain: Factory = (w, h) => {
  const scenery = layer(w, h, (ctx) => {
    // Blurry city lights through a wet window.
    for (let i = 0; i < count(w, h, 14000, 40, 110); i++) {
      const color = pick(['rgba(255,190,110,0.5)', 'rgba(255,120,150,0.4)', 'rgba(110,200,255,0.4)', 'rgba(255,230,160,0.45)']);
      const r = rand(14, 46);
      ctx.drawImage(glow(color, 64), rand(0, w) - r, rand(h * 0.55, h) - r, r * 2, r * 2);
    }
    const fog = ctx.createLinearGradient(0, 0, 0, h);
    fog.addColorStop(0, 'rgba(10,20,35,0.35)');
    fog.addColorStop(1, 'rgba(10,20,35,0)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, w, h);
  });

  const drops = Array.from({ length: count(w, h, 2600, 120, 520) }, () => ({
    x: rand(0, w),
    y: rand(0, h),
    len: rand(12, 28),
    speed: rand(650, 1050),
  }));
  const beads = Array.from({ length: count(w, h, 40000, 15, 45) }, () => ({
    x: rand(0, w),
    y: rand(0, h),
    r: rand(2, 6),
    vy: Math.random() < 0.35 ? rand(25, 80) : 0,
  }));
  let flash = 0;
  let nextFlash = rand(18, 35);

  return {
    backdrop: scenery,
    draw: (ctx, f) => {
      const speed = 1 + f.energy * 0.5;
      ctx.strokeStyle = 'rgba(170,200,255,0.32)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const d of drops) {
        d.y += d.speed * speed * f.dt;
        d.x += d.speed * 0.12 * f.dt;
        if (d.y > h) {
          d.y = rand(-40, 0);
          d.x = rand(-50, w);
        }
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * 0.12, d.y - d.len);
      }
      ctx.stroke();

      for (const b of beads) {
        b.y += b.vy * f.dt;
        if (b.y > h + 10) {
          b.y = rand(-10, h * 0.3);
          b.x = rand(0, w);
        }
        ctx.fillStyle = 'rgba(200,225,255,0.14)';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(b.x - b.r * 0.35, b.y - b.r * 0.45, 1.4, 1.4);
      }

      // A rare, soft flash of distant lightning.
      nextFlash -= f.dt;
      if (nextFlash <= 0) {
        flash = 1;
        nextFlash = rand(20, 40);
      }
      if (flash > 0) {
        ctx.fillStyle = `rgba(200,220,255,${flash * 0.09})`;
        ctx.fillRect(0, 0, w, h);
        flash = Math.max(0, flash - f.dt * 1.8);
      }
    },
  };
};

// ---------------------------------------------------------------- 🌙 Starry Night

const night: Factory = (w, h) => {
  const scenery = layer(w, h, (ctx) => {
    // Milky way: a soft diagonal band of dust.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.45);
    const band = ctx.createLinearGradient(0, -h * 0.18, 0, h * 0.18);
    band.addColorStop(0, 'rgba(160,140,255,0)');
    band.addColorStop(0.5, 'rgba(180,160,255,0.12)');
    band.addColorStop(1, 'rgba(160,140,255,0)');
    ctx.fillStyle = band;
    ctx.fillRect(-w, -h * 0.18, w * 2, h * 0.36);
    for (let i = 0; i < count(w, h, 900, 300, 1400); i++) {
      ctx.fillStyle = `rgba(255,255,255,${rand(0.05, 0.3)})`;
      ctx.fillRect(rand(-w, w), rand(-h * 0.16, h * 0.16) * Math.random(), 1, 1);
    }
    ctx.restore();

    // Moon with a halo.
    const mx = w * 0.8;
    const my = h * 0.2;
    const mr = Math.min(w, h) * 0.055 + 14;
    ctx.drawImage(glow('rgba(200,210,255,0.5)', 128), mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
    const disc = ctx.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, mr * 0.1, mx, my, mr);
    disc.addColorStop(0, '#fffdf2');
    disc.addColorStop(1, '#d9dcef');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,165,195,0.35)';
    for (const [dx, dy, r] of [[-0.3, -0.2, 0.18], [0.25, 0.1, 0.13], [-0.05, 0.4, 0.1], [0.35, -0.35, 0.08]]) {
      ctx.beginPath();
      ctx.arc(mx + dx * mr, my + dy * mr, r * mr, 0, Math.PI * 2);
      ctx.fill();
    }

    hills(ctx, w, h, h * 0.8, h * 0.06, 'rgba(25,20,60,0.9)', 2.2);
    hills(ctx, w, h, h * 0.88, h * 0.04, 'rgba(10,8,30,1)', 5.4);
  });

  const stars = Array.from({ length: count(w, h, 4000, 120, 420) }, () => ({
    x: rand(0, w),
    y: rand(0, h * 0.85),
    size: Math.random() < 0.12 ? 2 : 1,
    base: rand(0.3, 0.9),
    speed: rand(0.6, 2.4),
    phase: rand(0, Math.PI * 2),
  }));
  let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
  let nextShot = rand(2, 6);

  return {
    backdrop: scenery,
    draw: (ctx, f) => {
      const twinkle = 1 + f.energy;
      for (const s of stars) {
        const a = Math.max(0, Math.min(1, s.base + Math.sin(f.t * s.speed * twinkle + s.phase) * 0.35));
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(s.x, s.y, s.size, s.size);
      }

      nextShot -= f.dt;
      if (!shooting && nextShot <= 0) {
        shooting = { x: rand(w * 0.1, w * 0.7), y: rand(0, h * 0.35), vx: rand(500, 800), vy: rand(180, 300), life: 1 };
        nextShot = rand(3, 8);
      }
      if (shooting) {
        const s = shooting;
        s.x += s.vx * f.dt;
        s.y += s.vy * f.dt;
        s.life -= f.dt * 1.2;
        const tail = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 0.18, s.y - s.vy * 0.18);
        tail.addColorStop(0, `rgba(255,255,255,${Math.max(0, s.life)})`);
        tail.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = tail;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 0.18, s.y - s.vy * 0.18);
        ctx.stroke();
        if (s.life <= 0) shooting = null;
      }
    },
  };
};

// ---------------------------------------------------------------- 🌅 Golden Hour

const sunset: Factory = (w, h) => {
  const horizon = h * 0.66;
  const sunX = w * 0.5;
  const sunR = Math.min(w, h) * 0.09 + 20;
  const scenery = layer(w, h, (ctx) => {
    ctx.drawImage(glow('rgba(255,190,120,0.55)', 160), sunX - sunR * 4, horizon - sunR * 4, sunR * 8, sunR * 8);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, horizon);
    ctx.clip();
    const disc = ctx.createLinearGradient(0, horizon - sunR, 0, horizon + sunR);
    disc.addColorStop(0, '#ffe7a3');
    disc.addColorStop(1, '#ff8a5c');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(sunX, horizon + sunR * 0.15, sunR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Long soft clouds.
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = `rgba(255,${Math.round(rand(150, 200))},${Math.round(rand(160, 200))},${rand(0.12, 0.25)})`;
      ctx.beginPath();
      ctx.ellipse(rand(0, w), rand(h * 0.12, h * 0.5), rand(w * 0.12, w * 0.3), rand(6, 16), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Distant island silhouettes on the horizon.
    ctx.fillStyle = 'rgba(40,20,60,0.85)';
    ctx.beginPath();
    ctx.moveTo(w * 0.05, horizon);
    ctx.quadraticCurveTo(w * 0.14, horizon - h * 0.05, w * 0.24, horizon);
    ctx.moveTo(w * 0.7, horizon);
    ctx.quadraticCurveTo(w * 0.8, horizon - h * 0.035, w * 0.93, horizon);
    ctx.fill();
  });

  const motes = Array.from({ length: count(w, h, 30000, 25, 70) }, () => ({
    x: rand(0, w),
    y: rand(0, h),
    r: rand(3, 10),
    vy: rand(-14, -4),
    phase: rand(0, Math.PI * 2),
  }));
  const birds = Array.from({ length: 4 }, (_, i) => ({ x: rand(-w * 0.5, w), y: rand(h * 0.15, h * 0.4), v: rand(25, 45), s: rand(6, 10), phase: i }));

  return {
    backdrop: scenery,
    draw: (ctx, f) => {
      // Shimmering reflection on the water (it glints harder with the music).
      for (let i = 0; i < 16; i++) {
        const y = horizon + 6 + i * ((h - horizon) / 16);
        const width = sunR * (2.2 - i * 0.1) * (0.6 + 0.4 * Math.sin(f.t * 1.5 + i * 1.7)) * (1 + f.energy * 0.3);
        ctx.fillStyle = `rgba(255,200,140,${0.35 - i * 0.018})`;
        ctx.fillRect(sunX - width / 2, y, width, 2.2);
      }

      ctx.globalCompositeOperation = 'lighter';
      const sprite = glow('rgba(255,210,150,0.5)', 32);
      for (const m of motes) {
        m.y += m.vy * f.dt;
        m.x += Math.sin(f.t * 0.6 + m.phase) * 6 * f.dt;
        if (m.y < -20) {
          m.y = h + 20;
          m.x = rand(0, w);
        }
        ctx.drawImage(sprite, m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';

      ctx.strokeStyle = 'rgba(40,20,50,0.75)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const b of birds) {
        b.x += b.v * f.dt;
        if (b.x > w + 40) {
          b.x = -40;
          b.y = rand(h * 0.15, h * 0.4);
        }
        const flap = Math.sin(f.t * 6 + b.phase) * b.s * 0.6;
        ctx.moveTo(b.x - b.s, b.y - flap);
        ctx.quadraticCurveTo(b.x - b.s * 0.4, b.y - b.s * 0.3, b.x, b.y);
        ctx.quadraticCurveTo(b.x + b.s * 0.4, b.y - b.s * 0.3, b.x + b.s, b.y - flap);
      }
      ctx.stroke();
    },
  };
};

// ---------------------------------------------------------------- 🌲 Firefly Forest

const forest: Factory = (w, h) => {
  const scenery = layer(w, h, (ctx) => {
    const haze = ctx.createRadialGradient(w * 0.5, h * 0.25, 0, w * 0.5, h * 0.25, Math.max(w, h) * 0.6);
    haze.addColorStop(0, 'rgba(180,230,200,0.18)');
    haze.addColorStop(1, 'rgba(180,230,200,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, w, h);

    const pine = (x: number, base: number, height: number, color: string) => {
      ctx.fillStyle = color;
      const tiers = 5;
      for (let i = 0; i < tiers; i++) {
        const top = base - height + (i * height) / (tiers + 1);
        const width = (height / 3.2) * ((i + 1.4) / tiers);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x - width, top + height / 2.6);
        ctx.lineTo(x + width, top + height / 2.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillRect(x - height * 0.025, base - height * 0.12, height * 0.05, height * 0.14);
    };
    const rows: [number, number, string][] = [
      [h * 0.72, h * 0.32, 'rgba(22,70,50,0.55)'],
      [h * 0.82, h * 0.42, 'rgba(10,45,30,0.8)'],
      [h * 0.95, h * 0.55, 'rgba(3,20,13,0.97)'],
    ];
    for (const [base, size, color] of rows) {
      for (let x = -40; x < w + 40; x += rand(size * 0.22, size * 0.42)) pine(x, base + rand(-10, 10), size * rand(0.7, 1.05), color);
      ctx.fillStyle = color;
      ctx.fillRect(0, base - 2, w, h - base + 2);
    }
  });

  const flies = Array.from({ length: count(w, h, 22000, 25, 70) }, () => ({
    x: rand(0, w),
    y: rand(h * 0.25, h * 0.95),
    angle: rand(0, Math.PI * 2),
    speed: rand(10, 28),
    blink: rand(0.6, 1.6),
    phase: rand(0, Math.PI * 2),
    size: rand(10, 18),
  }));
  const mist = Array.from({ length: 3 }, (_, i) => ({ x: rand(0, w), y: h * (0.6 + i * 0.12), v: rand(6, 14) }));

  return {
    backdrop: scenery,
    draw: (ctx, f) => {
      for (const m of mist) {
        m.x = (m.x + m.v * f.dt) % (w + 600);
        ctx.drawImage(glow('rgba(200,240,220,0.06)', 64), m.x - 600, m.y - 80, 900, 160);
      }
      ctx.globalCompositeOperation = 'lighter';
      const sprite = glow('rgba(214,255,120,0.9)', 32);
      for (const fl of flies) {
        fl.angle += rand(-1.5, 1.5) * f.dt;
        fl.x += Math.cos(fl.angle) * fl.speed * f.dt;
        fl.y += Math.sin(fl.angle) * fl.speed * 0.6 * f.dt;
        if (fl.x < -20) fl.x = w + 20;
        if (fl.x > w + 20) fl.x = -20;
        if (fl.y < h * 0.2 || fl.y > h) fl.angle = -fl.angle;
        const a = 0.15 + 0.85 * Math.max(0, Math.sin(f.t * fl.blink + fl.phase)) * (0.7 + f.energy * 0.6);
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprite, fl.x - fl.size, fl.y - fl.size, fl.size * 2, fl.size * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },
  };
};

// ---------------------------------------------------------------- 🌊 Ocean Breeze

const ocean: Factory = (w, h) => {
  const waves = [
    { base: 0.56, amp: 10, len: 340, speed: 0.35, color: 'rgba(160,230,240,0.55)' },
    { base: 0.64, amp: 14, len: 280, speed: -0.45, color: 'rgba(70,185,215,0.6)' },
    { base: 0.74, amp: 18, len: 230, speed: 0.55, color: 'rgba(25,130,175,0.75)' },
    { base: 0.86, amp: 22, len: 200, speed: -0.65, color: 'rgba(8,80,120,0.9)' },
  ];
  const bubbles = Array.from({ length: count(w, h, 35000, 15, 45) }, () => ({
    x: rand(0, w),
    y: rand(h * 0.6, h),
    r: rand(2, 6),
    vy: rand(-30, -12),
    phase: rand(0, Math.PI * 2),
  }));

  return {
    backdrop: null,
    draw: (ctx, f) => {
      // Light shafts from the surface.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const x = w * (0.1 + i * 0.2) + Math.sin(f.t * 0.2 + i) * 40;
        ctx.fillStyle = `rgba(255,255,255,${0.04 + 0.03 * Math.sin(f.t * 0.5 + i * 1.3)})`;
        ctx.beginPath();
        ctx.moveTo(x - 30, 0);
        ctx.lineTo(x + 30, 0);
        ctx.lineTo(x + 140, h);
        ctx.lineTo(x - 40, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      const swell = 1 + f.energy * 0.6;
      for (const wave of waves) {
        const base = h * wave.base;
        ctx.fillStyle = wave.color;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w + 16; x += 16) {
          const y =
            base +
            Math.sin(x / wave.len + f.t * wave.speed * 2) * wave.amp * swell +
            Math.sin(x / (wave.len * 0.43) - f.t * wave.speed * 3) * wave.amp * 0.35;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const b of bubbles) {
        b.y += b.vy * f.dt;
        b.x += Math.sin(f.t * 2 + b.phase) * 8 * f.dt;
        if (b.y < h * 0.58) {
          b.y = h + 10;
          b.x = rand(0, w);
        }
        ctx.moveTo(b.x + b.r, b.y);
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      }
      ctx.stroke();
    },
  };
};

// ---------------------------------------------------------------- 🎉 Neon Party

const party: Factory = (w, h) => {
  const neon = ['#ff2bd6', '#22d3ee', '#a855f7', '#facc15', '#34d399', '#fb7185'];
  const confetti = Array.from({ length: count(w, h, 14000, 40, 120) }, () => ({
    x: rand(0, w),
    y: rand(-h, h),
    vy: rand(50, 120),
    vx: rand(-20, 20),
    rot: rand(0, Math.PI * 2),
    vr: rand(-6, 6),
    color: pick(neon),
    s: rand(4, 8),
  }));
  const rings: { r: number; life: number; color: string }[] = [];
  let lastBeat = 0;
  const bars = 36;

  return {
    backdrop: null,
    draw: (ctx, f) => {
      const beat = f.energy;
      ctx.globalCompositeOperation = 'lighter';

      // Roaming spotlights.
      for (let i = 0; i < 3; i++) {
        const x = w * (0.5 + Math.sin(f.t * (0.3 + i * 0.13) + i * 2) * 0.4);
        const y = h * (0.45 + Math.cos(f.t * (0.25 + i * 0.1) + i) * 0.3);
        const r = Math.max(w, h) * (0.22 + beat * 0.08);
        ctx.globalAlpha = 0.35 + beat * 0.35;
        ctx.drawImage(glow(['rgba(255,43,214,0.6)', 'rgba(34,211,238,0.6)', 'rgba(168,85,247,0.6)'][i], 128), x - r, y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;

      // Lasers sweeping from the floor.
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 6; i++) {
        const ox = i < 3 ? w * 0.08 : w * 0.92;
        const angle = -Math.PI / 2 + Math.sin(f.t * (0.8 + i * 0.17) + i) * 0.7;
        ctx.strokeStyle = neon[i % neon.length];
        ctx.globalAlpha = 0.18 + beat * 0.45;
        ctx.beginPath();
        ctx.moveTo(ox, h);
        ctx.lineTo(ox + Math.cos(angle) * h * 1.5, h + Math.sin(angle) * h * 1.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // A ring bursts out on every beat.
      if (beat > 0.55 && f.t - lastBeat > 0.28) {
        lastBeat = f.t;
        rings.push({ r: 20, life: 1, color: pick(neon) });
      }
      ctx.lineWidth = 3;
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.r += 420 * f.dt;
        ring.life -= f.dt * 0.9;
        if (ring.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = ring.color;
        ctx.globalAlpha = ring.life * 0.6;
        ctx.beginPath();
        ctx.arc(w / 2, h * 0.45, ring.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Equalizer along the bottom.
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = 0.15 + Math.abs(Math.sin(f.t * (2 + (i % 5) * 0.7) + i * 1.3)) * 0.45 + beat * 0.5;
        const bh = v * h * 0.16;
        ctx.fillStyle = neon[i % neon.length];
        ctx.globalAlpha = 0.35;
        ctx.fillRect(i * bw + 2, h - bh, bw - 4, bh);
      }
      ctx.globalAlpha = 1;

      for (const c of confetti) {
        c.y += c.vy * (1 + beat * 0.8) * f.dt;
        c.x += c.vx * f.dt;
        c.rot += c.vr * f.dt;
        if (c.y > h + 10) {
          c.y = -10;
          c.x = rand(0, w);
        }
        const cos = Math.cos(c.rot);
        const sin = Math.sin(c.rot);
        ctx.setTransform(cos, sin, -sin * 0.5, cos * 0.5, c.x, c.y);
        ctx.fillStyle = c.color;
        ctx.fillRect(-c.s / 2, -c.s / 4, c.s, c.s / 2);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
  };
};

export const SCENES: Record<MoodId, Factory> = { calm, rain, night, sunset, forest, ocean, party };
