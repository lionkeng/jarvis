import type { VisualizationPreset, VizFrame } from "../types.js";
import { paletteColor } from "../color.js";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
}

export class ParticlePreset implements VisualizationPreset {
  readonly name = "particles";
  readonly layer = 40;
  #particles: Particle[] = [];

  paint(frame: VizFrame): void {
    const { context, regions, features, theme, deltaSeconds, reducedMotion } = frame;
    const rect = regions.viz;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    if (!reducedMotion && features.onset > 0.08) {
      const count = Math.min(28, Math.max(1, Math.round((2 + features.onset * 12) * theme.density)));
      for (let index = 0; index < count; index += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = (18 + Math.random() * 52 + features.level * 80) * theme.scale;
        const color = paletteColor(theme.palette, Math.floor(Math.random() * theme.palette.length), theme.accent);
        this.#particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 8,
          age: 0,
          life: 0.5 + Math.random() * 0.8,
          size: (1.5 + Math.random() * 3.5 * (1 + features.centroid)) * theme.strokeWeight,
          color,
        });
      }
      const maxParticles = Math.round(180 * theme.density);
      if (this.#particles.length > maxParticles) this.#particles.splice(0, this.#particles.length - maxParticles);
    }

    const drag = Math.pow(0.995, deltaSeconds * 60);
    this.#particles = this.#particles.filter((particle) => {
      particle.age += deltaSeconds;
      particle.vy += 8 * deltaSeconds;
      particle.vx *= drag;
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;
      const alpha = 1 - particle.age / particle.life;
      if (alpha <= 0) return false;
      context.globalAlpha = alpha * 0.7;
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * alpha, 0, Math.PI * 2);
      context.fill();
      return true;
    });
    context.globalAlpha = 1;
  }

  dispose(): void {
    this.#particles = [];
  }
}
