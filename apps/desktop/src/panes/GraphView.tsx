import React, { useEffect, useRef, useState } from 'react';
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide,
  type Simulation, type SimulationNodeDatum,
} from 'd3-force';
import type { GraphData, GraphNode } from '../../shared/ipc';
import { useApp } from '../store';

interface SimNode extends SimulationNodeDatum, GraphNode {}
interface SimEdge { source: SimNode; target: SimNode; kind: 'semantic' | 'retrieval'; weight: number }

const COLORS = {
  private: '#39FF6A',
  public: '#E8521A',
  query: '#E8521A',
  semantic: 'rgba(57,255,106,0.22)',
  retrieval: 'rgba(232,82,26,0.55)',
};

export function GraphView() {
  const app = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null);
  const stateRef = useRef({ nodes: [] as SimNode[], edges: [] as SimEdge[], scale: 1, ox: 0, oy: 0, w: 0, h: 0 });
  const [empty, setEmpty] = useState(false);

  // Build / rebuild the simulation from graph data.
  useEffect(() => {
    let alive = true;
    window.rdk.getGraphData().then((data: GraphData) => {
      if (!alive) return;
      setEmpty(data.nodes.filter(n => n.kind === 'file').length === 0);
      const byId = new Map<string, SimNode>();
      const nodes: SimNode[] = data.nodes.map(n => {
        const sn: SimNode = { ...n };
        byId.set(n.id, sn);
        return sn;
      });
      const edges: SimEdge[] = data.edges
        .map(e => {
          const s = byId.get(e.source); const t = byId.get(e.target);
          return s && t ? { source: s, target: t, kind: e.kind, weight: e.weight } : null;
        })
        .filter((e): e is SimEdge => e !== null);
      stateRef.current.nodes = nodes;
      stateRef.current.edges = edges;

      simRef.current?.stop();
      const sim = forceSimulation<SimNode, SimEdge>(nodes)
        .force('charge', forceManyBody().strength(-90))
        .force('link', forceLink<SimNode, SimEdge>(edges)
          .distance(e => (e.kind === 'semantic' ? 60 : 110))
          .strength(e => (e.kind === 'semantic' ? 0.35 * e.weight : 0.08)))
        .force('center', forceCenter(0, 0).strength(0.04))
        .force('collide', forceCollide<SimNode>().radius(n => radius(n) + 6))
        .velocityDecay(0.28)
        .alpha(1)
        .alphaTarget(0.015) // never fully freeze → gentle perpetual float
        .on('tick', draw);
      simRef.current = sim;
    });
    return () => { alive = false; simRef.current?.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.dataVersion]);

  // Canvas sizing (device-pixel-ratio aware).
  useEffect(() => {
    const canvas = canvasRef.current!; const wrap = wrapRef.current!;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
      const st = stateRef.current;
      st.w = r.width; st.h = r.height;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function radius(n: GraphNode): number {
    if (n.kind === 'query') return 5;
    return 4 + Math.min(10, Math.sqrt(n.retrievals) * 2.2);
  }

  function draw() {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const st = stateRef.current;
    ctx.clearRect(0, 0, st.w, st.h);
    ctx.save();
    ctx.translate(st.w / 2 + st.ox, st.h / 2 + st.oy);
    ctx.scale(st.scale, st.scale);

    // edges
    for (const e of st.edges) {
      const sx = e.source.x ?? 0, sy = e.source.y ?? 0, tx = e.target.x ?? 0, ty = e.target.y ?? 0;
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(tx, ty);
      if (e.kind === 'retrieval') {
        ctx.strokeStyle = COLORS.retrieval; ctx.lineWidth = 0.8; ctx.setLineDash([3, 3]);
      } else {
        ctx.strokeStyle = COLORS.semantic; ctx.lineWidth = 0.7; ctx.setLineDash([]);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // nodes
    for (const n of st.nodes) {
      const r = radius(n);
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
      if (n.kind === 'query') {
        // ringed / hollow orange
        ctx.fillStyle = 'rgba(232,82,26,0.12)'; ctx.fill();
        ctx.lineWidth = 1.4; ctx.strokeStyle = COLORS.query; ctx.stroke();
      } else {
        const c = n.state === 'public' ? COLORS.public : COLORS.private;
        ctx.fillStyle = c; ctx.fill();
        if (n.id === app.selectedChunkId) { ctx.lineWidth = 2; ctx.strokeStyle = '#C8FFC8'; ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  // Interaction: click = pick node; drag = pan; wheel = zoom.
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  function toWorld(cx: number, cy: number) {
    const st = stateRef.current;
    return { x: (cx - st.w / 2 - st.ox) / st.scale, y: (cy - st.h / 2 - st.oy) / st.scale };
  }

  function pick(cx: number, cy: number): SimNode | null {
    const { x, y } = toWorld(cx, cy);
    let best: SimNode | null = null; let bestD = Infinity;
    for (const n of stateRef.current.nodes) {
      const dx = (n.x ?? 0) - x, dy = (n.y ?? 0) - y;
      const d = dx * dx + dy * dy;
      const rr = (radius(n) + 4) ** 2;
      if (d < rr && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x, dy = e.clientY - dragRef.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      dragRef.current.moved = true;
      stateRef.current.ox += dx; stateRef.current.oy += dy;
      dragRef.current.x = e.clientX; dragRef.current.y = e.clientY;
      draw();
    }
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const wasDrag = dragRef.current?.moved;
    dragRef.current = null;
    if (wasDrag) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const n = pick(e.clientX - rect.left, e.clientY - rect.top);
    if (n && n.kind === 'file') {
      app.selectChunk(n.id);
      app.openContentForChunk(n.id, n.label);
      draw();
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const st = stateRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    st.scale = Math.max(0.2, Math.min(4, st.scale * factor));
    draw();
  };

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'grab' }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={() => (dragRef.current = null)}
        onWheel={onWheel}
      />
      {empty && (
        <div className="center-full" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', color: 'var(--muted)' }}>
          Index some notes to populate the graph.
        </div>
      )}
      <div className="legend">
        <div className="row"><span className="swatch" style={{ borderTopColor: COLORS.private, width: 18 }} /> semantic link</div>
        <div className="row"><span className="swatch" style={{ borderTopColor: COLORS.query, borderTopStyle: 'dashed', width: 18 }} /> retrieved by query</div>
        <div className="row"><span className="dot private" /> private &nbsp; <span className="dot public" /> public</div>
      </div>
    </div>
  );
}
